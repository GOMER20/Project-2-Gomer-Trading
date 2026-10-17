import { AuthGate } from '@/components/AuthGate';
import { Terminal } from '@/components/terminal/Terminal';

export default function TerminalPage() {
  return (
    <AuthGate>
      <Terminal />
    </AuthGate>
  );
}
