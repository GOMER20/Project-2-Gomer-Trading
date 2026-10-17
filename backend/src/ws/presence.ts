/**
 * Who has the terminal open right now. Kept apart from the gateway so HTTP
 * handlers can ask without importing the WebSocket server.
 */
let connectedUsers: () => Iterable<string> = () => [];

export const presence = {
  /** The gateway registers how to list the users it has connections for. */
  provide(list: () => Iterable<string>): void {
    connectedUsers = list;
  },
  onlineUserIds(): Set<string> {
    return new Set(connectedUsers());
  },
};
