import type { Metadata } from 'next';
import { AuthGate } from '@/components/AuthGate';
import { HftWindow } from '@/components/labs/HftWindow';

export const metadata: Metadata = { title: 'HFT · High-frequency trading · Gomer Trading' };

export default function HftPage() {
  return (
    <AuthGate ownerOnly>
      <HftWindow />
    </AuthGate>
  );
}
