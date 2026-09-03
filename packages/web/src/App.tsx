import { PROTOCOL_VERSION } from '@remotepi/shared';

export function App() {
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem' }}>
      <h1>RemotePi</h1>
      <p>M1 scaffold — web UI lands in later milestones.</p>
      <p>
        Shared protocol version: <code>{PROTOCOL_VERSION}</code>
      </p>
    </main>
  );
}
