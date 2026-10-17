'use client';

import { useEffect } from 'react';
import { useMarketStore } from '@/store/market';
import { useTradingStore } from '@/store/trading';
import { api, webSocketUrl } from './api';
import type { Depth, FeedHealth, Leaderboard, Order, Quote } from './types';

type ServerMessage =
  | { type: 'ready'; traderId: string; provider: string; feed?: FeedHealth }
  | { type: 'feed'; data: FeedHealth }
  | { type: 'quote'; data: Quote }
  | { type: 'quotes'; data: Quote[] }
  | { type: 'order'; competitionId: string; data: Order }
  | { type: 'depth'; data: Depth }
  | { type: 'leaderboard'; data: Leaderboard }
  | { type: 'error'; code: string; message: string; symbol?: string }
  | { type: 'pong' };

const MAX_BACKOFF_MS = 15_000;

/**
 * The single WebSocket to the backend.
 *
 *  - reference-counts symbol subscriptions, so the watchlist, the chart and the
 *    positions table can each ask for a symbol without stepping on each other
 *  - reconnects with backoff and replays every subscription once re-authenticated
 *  - coalesces incoming quotes into one store update per animation frame
 */
class GomerSocket {
  private ws: WebSocket | null = null;
  private token: string | null = null;
  private ready = false;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly refs = new Map<string, number>();
  private competitionId: string | null = null;
  private depthSymbol: string | null = null;
  private readonly pending = new Map<string, Quote>();
  private flush: { frame: number; timer: ReturnType<typeof setTimeout> } | null = null;

  connect(token: string): void {
    if (this.token === token && this.ws) return;
    this.teardown();
    this.token = token;
    this.open();
  }

  disconnect(): void {
    this.teardown();
    this.token = null;
    useMarketStore.getState().setStatus('offline');
  }

  retain(symbols: string[]): void {
    const added: string[] = [];
    for (const symbol of symbols) {
      const count = this.refs.get(symbol) ?? 0;
      this.refs.set(symbol, count + 1);
      if (count === 0) added.push(symbol);
    }
    if (added.length) this.send({ type: 'subscribe', symbols: added });
  }

  release(symbols: string[]): void {
    const removed: string[] = [];
    for (const symbol of symbols) {
      const count = this.refs.get(symbol);
      if (count === undefined) continue;
      if (count > 1) this.refs.set(symbol, count - 1);
      else {
        this.refs.delete(symbol);
        removed.push(symbol);
      }
    }
    if (removed.length) this.send({ type: 'unsubscribe', symbols: removed });
  }

  /** Level 2 for one symbol at a time: the one on screen. Null stops it. */
  watchDepth(symbol: string | null): void {
    if (this.depthSymbol === symbol) return;
    this.depthSymbol = symbol;
    useMarketStore.getState().setDepth(null);
    this.send({ type: 'depth', symbol });
  }

  followLeaderboard(competitionId: string | null): void {
    this.competitionId = competitionId;
    if (competitionId) this.send({ type: 'leaderboard', competitionId });
  }

  private open(): void {
    if (!this.token) return;
    useMarketStore.getState().setStatus(this.attempt === 0 ? 'connecting' : 'reconnecting');

    const ws = new WebSocket(webSocketUrl());
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws === ws && this.token) ws.send(JSON.stringify({ type: 'auth', token: this.token }));
    };

    ws.onmessage = (event) => {
      if (this.ws !== ws) return;
      let message: ServerMessage;
      try {
        message = JSON.parse(event.data as string) as ServerMessage;
      } catch {
        return;
      }
      this.handle(message);
    };

    ws.onclose = () => {
      if (this.ws !== ws) return; // superseded by a newer connection
      this.ws = null;
      this.ready = false;
      if (!this.token) return;
      useMarketStore.getState().setStatus('reconnecting');
      const delay = Math.min(MAX_BACKOFF_MS, 500 * 2 ** this.attempt++);
      this.retryTimer = setTimeout(() => this.open(), delay);
    };
  }

  private handle(message: ServerMessage): void {
    switch (message.type) {
      case 'ready': {
        this.ready = true;
        this.attempt = 0;
        useMarketStore.getState().setStatus('live', message.provider);
        useMarketStore.getState().setFeed(message.feed ?? null);
        const symbols = [...this.refs.keys()];
        // The server accepts at most 50 symbols per message.
        for (let i = 0; i < symbols.length; i += 50) this.send({ type: 'subscribe', symbols: symbols.slice(i, i + 50) });
        if (this.competitionId) this.send({ type: 'leaderboard', competitionId: this.competitionId });
        if (this.depthSymbol) this.send({ type: 'depth', symbol: this.depthSymbol });
        break;
      }
      case 'quote':
        this.pending.set(message.data.symbol, message.data);
        this.scheduleFlush();
        break;
      case 'quotes':
        for (const quote of message.data) this.pending.set(quote.symbol, quote);
        this.scheduleFlush();
        break;
      case 'order':
        useTradingStore.getState().onOrderEvent(message.competitionId, message.data);
        break;
      case 'leaderboard':
        useTradingStore.getState().setLeaderboard(message.data);
        break;
      case 'feed':
        useMarketStore.getState().setFeed(message.data);
        break;
      case 'depth':
        // A late frame for a symbol the trader has already left is dropped.
        if (message.data.symbol === this.depthSymbol) useMarketStore.getState().setDepth(message.data);
        break;
      case 'error':
        // The server says this session is over (signed out, password changed elsewhere, or deactivated).
        // Ask it properly before acting: a 401 there signs the trader out, while a trader who has just
        // changed their own password already holds a fresh session and simply reconnects.
        if (message.code === 'UNAUTHORIZED') setTimeout(() => void api('/api/auth/me').catch(() => undefined), 1500);
        if (message.code === 'UNKNOWN_SYMBOL' && message.symbol) useMarketStore.getState().markUnknown(message.symbol);
        break;
      case 'pong':
        break;
    }
  }

  /**
   * Applies buffered quotes on the next animation frame. Browsers pause
   * animation frames for a hidden or fully covered window, so a timer backs
   * it up: prices, P&L and candles keep moving even when nobody is looking.
   */
  private scheduleFlush(): void {
    if (this.flush) return;
    const run = () => {
      if (!this.flush) return;
      cancelAnimationFrame(this.flush.frame);
      clearTimeout(this.flush.timer);
      this.flush = null;
      const batch = [...this.pending.values()];
      this.pending.clear();
      useMarketStore.getState().applyQuotes(batch);
    };
    this.flush = { frame: requestAnimationFrame(run), timer: setTimeout(run, 250) };
  }

  private send(payload: object): void {
    // Dropped while offline on purpose: 'ready' replays the full subscription state.
    if (this.ready && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(payload));
  }

  private teardown(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.ready = false;
    this.attempt = 0;
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }
}

export const socket = new GomerSocket();

/** Streams quotes for the given symbols while the calling component is mounted. */
export function useQuoteSubscription(symbols: string[]): void {
  const key = [...new Set(symbols)].sort().join(',');
  useEffect(() => {
    const list = key ? key.split(',') : [];
    socket.retain(list);
    return () => socket.release(list);
  }, [key]);
}
