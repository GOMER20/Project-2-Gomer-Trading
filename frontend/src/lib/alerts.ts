'use client';

import { useAlertStore } from '@/store/alerts';
import { desktopBridge } from './desktop';

/**
 * Getting the trader's attention: a short chime, and a system notification
 * when the app is not the window in front (in front, the message on screen is
 * enough). Both can be switched off in the Alerts tab.
 */

let audio: AudioContext | null = null;

/** Two rising notes for a fill, three for a price alert. Made on the fly: there is no sound file to load. */
export function chime(kind: 'fill' | 'alert'): void {
  try {
    audio ??= new AudioContext();
    if (audio.state === 'suspended') void audio.resume();
    const start = audio.currentTime + 0.01;
    const notes = kind === 'fill' ? [880, 1318.5] : [659.3, 987.8, 1318.5];
    notes.forEach((frequency, i) => {
      const at = start + i * 0.09;
      const tone = audio!.createOscillator();
      const volume = audio!.createGain();
      tone.type = 'sine';
      tone.frequency.value = frequency;
      volume.gain.setValueAtTime(0.0001, at);
      volume.gain.exponentialRampToValueAtTime(0.12, at + 0.012);
      volume.gain.exponentialRampToValueAtTime(0.0001, at + 0.22);
      tone.connect(volume).connect(audio!.destination);
      tone.start(at);
      tone.stop(at + 0.25);
    });
  } catch {
    // no sound available
  }
}

/** A system notification: through the desktop app, or the browser's own (which asks the trader once). */
export function popup(title: string, body?: string): void {
  const desktop = desktopBridge();
  if (desktop?.notify) return desktop.notify(title, body ?? '');
  if (typeof Notification === 'undefined') return;
  if (Notification.permission === 'granted') new Notification(title, { body });
}

/** Asks the browser for permission to show notifications. The desktop app needs none. */
export async function allowPopups(): Promise<'granted' | 'denied' | 'default' | 'desktop'> {
  if (desktopBridge()?.notify) return 'desktop';
  if (typeof Notification === 'undefined') return 'denied';
  if (Notification.permission !== 'default') return Notification.permission;
  return Notification.requestPermission();
}

/** Sounds and pops up whatever the trader has switched on. */
export function signal(kind: 'fill' | 'alert', title: string, body?: string): void {
  const { sound, popups } = useAlertStore.getState();
  if (sound) chime(kind);
  const away = typeof document !== 'undefined' && (document.hidden || !document.hasFocus());
  if (popups && away) popup(title, body);
}
