#!/usr/bin/env python3
"""A bot for the low-latency gateway using only the Python standard library.

Logs on, prints the best bid and offer and the top of the book, sells 10 shares
at the market (fill-or-kill), and prints every execution report it is sent.

    GOMER_API_KEY=gtk_... python3 binary_bot.py /tmp/gomer-gateway.sock AAPL    # Unix socket
    GOMER_API_KEY=gtk_... python3 binary_bot.py 127.0.0.1:4010 AAPL             # TCP

The struct formats below are docs/gateway/gomer_gateway.h written for `struct`.
"""
import os
import socket
import struct
import sys
import time

SCALE = 10_000
HEADER = struct.Struct("<HBBI")  # length, type, version, seq
LOGON, LOGON_ACK, REJECT, SUBSCRIBE, NEW_ORDER, EXEC_REPORT, BBO, TRADE, DEPTH = 0x01, 0x02, 0x05, 0x10, 0x20, 0x30, 0x40, 0x41, 0x42
BODY = {
    LOGON: struct.Struct("<64sII"),
    LOGON_ACK: struct.Struct("<B3xIQ24s16sq"),
    REJECT: struct.Struct("<IBxHQ48s"),
    SUBSCRIBE: struct.Struct("<8sB7x"),
    NEW_ORDER: struct.Struct("<Q8sBBBxIqq"),
    EXEC_REPORT: struct.Struct("<Q16s8sBBBBIIII4xqqqqQ"),
    BBO: struct.Struct("<8sqqIIQ"),
    TRADE: struct.Struct("<8sqI4xQ"),
}
EXEC_TYPES = ["NEW", "PARTIAL_FILL", "FILL", "CANCELED", "REJECTED", "TRIGGERED", "STATUS", "RESTATED"]
ORD_STATUSES = ["NEW", "PARTIALLY_FILLED", "FILLED", "CANCELED", "REJECTED"]


class Gateway:
    def __init__(self, where: str):
        if where.startswith("/"):
            self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self.sock.connect(where)
        else:
            host, port = where.rsplit(":", 1)
            self.sock = socket.create_connection((host, int(port)))
            self.sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        self.seq = 0
        self.buffer = b""

    def send(self, kind: int, *fields) -> int:
        self.seq += 1
        body = BODY[kind].pack(*fields)
        self.sock.sendall(HEADER.pack(HEADER.size + len(body), kind, 1, self.seq) + body)
        return self.seq

    def read(self):
        """Returns (type, body bytes) for the next frame."""
        while True:
            if len(self.buffer) >= HEADER.size:
                length, kind, _version, _seq = HEADER.unpack_from(self.buffer)
                if len(self.buffer) >= length:
                    frame, self.buffer = self.buffer[HEADER.size:length], self.buffer[length:]
                    return kind, frame
            chunk = self.sock.recv(65536)
            if not chunk:
                raise SystemExit("the gateway closed the connection")
            self.buffer += chunk


def text(raw: bytes) -> str:
    return raw.split(b"\0", 1)[0].decode("ascii")


def main() -> None:
    key = os.environ.get("GOMER_API_KEY")
    if len(sys.argv) < 3 or not key:
        raise SystemExit("usage: GOMER_API_KEY=gtk_... binary_bot.py <socket path | host:port> <SYMBOL>")
    gateway, symbol = Gateway(sys.argv[1]), sys.argv[2].upper().encode()

    gateway.send(LOGON, key.encode(), 0, 0)
    kind, body = gateway.read()
    if kind != LOGON_ACK:
        raise SystemExit(f"logon refused: {text(BODY[REJECT].unpack(body)[4])}")
    _status, rate, _session, trader, _competition, balance = BODY[LOGON_ACK].unpack(body)
    print(f"logged on as {text(trader)}, starting balance ${balance / SCALE:,.2f}, {rate} orders a second")

    gateway.send(SUBSCRIBE, symbol, 1 | 4)  # bbo + depth
    seen = set()
    while seen != {BBO, DEPTH}:
        kind, body = gateway.read()
        if kind == BBO and BBO not in seen:
            _s, bid, ask, bid_size, ask_size, _ts = BODY[BBO].unpack(body)
            print(f"{symbol.decode()}  bid {bid / SCALE:.2f} x {bid_size}   ask {ask / SCALE:.2f} x {ask_size}")
        elif kind == DEPTH and DEPTH not in seen:
            _s, _ts, bids, asks = struct.unpack_from("<8sQBB6x", body)
            levels = [struct.unpack_from("<qI4x", body, 24 + 16 * i) for i in range(bids + asks)]
            print("book  bids", [(p / SCALE, q) for p, q in levels[:3]], " asks", [(p / SCALE, q) for p, q in levels[bids:bids + 3]])
        seen.add(kind)

    cl_ord_id = time.time_ns()
    sent = time.perf_counter_ns()
    gateway.send(NEW_ORDER, cl_ord_id, symbol, 2, 1, 4, 10, 0, 0)  # SELL, MARKET, FOK, 10 shares
    while True:
        kind, body = gateway.read()
        if kind == REJECT:
            _ref_seq, _ref_type, code, ref, why = BODY[REJECT].unpack(body)
            if ref == cl_ord_id:
                raise SystemExit(f"order refused (code {code}): {text(why)}")
        if kind != EXEC_REPORT:
            continue  # market data keeps arriving in between
        ref, _order_id, sym, exec_type, status, _side, _type, qty, cum, leaves, last, last_px, avg_px, commission, slippage, _ts = BODY[EXEC_REPORT].unpack(body)
        if ref != cl_ord_id:
            continue
        micros = (time.perf_counter_ns() - sent) / 1000
        print(f"{EXEC_TYPES[exec_type]} after {micros:.0f} microseconds: {cum} of {qty} {text(sym)} done at {avg_px / SCALE:.4f} (last {last} @ {last_px / SCALE:.4f}), "
              f"slippage {slippage / SCALE:.4f} a share, commission ${commission / SCALE:.2f}, order is {ORD_STATUSES[status]}, {leaves} left")
        if ORD_STATUSES[status] in ("FILLED", "CANCELED", "REJECTED"):
            break


if __name__ == "__main__":
    main()
