import type { Metadata } from 'next';
import { AuthGate } from '@/components/AuthGate';
import { AtWindow } from '@/components/labs/AtWindow';

export const metadata: Metadata = { title: 'AT · Algorithmic trading · Gomer Trading' };

export default function AtPage() {
  return (
    <AuthGate ownerOnly>
      <AtWindow />
    </AuthGate>
  );
}
