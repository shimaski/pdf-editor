import type { SupabaseClient, RealtimeChannel } from '@supabase/supabase-js';
import type { EditorPage } from '../editor/model';

export type CollaboratorPresence = {
  userId: string;
  email?: string;
  page?: number;
  selection?: string | null;
  onlineAt: string;
};

export type DocumentOperation = {
  id: string;
  documentId: string;
  clientId: string;
  sequence: number;
  baseRevision: number;
  type: 'replacePages';
  pages: EditorPage[];
  basePages?: EditorPage[];
  createdAt: string;
};

export type CollaborationConflict = {
  incoming: DocumentOperation;
  localRevision: number;
  reason: 'stale-base';
};

type CollaborationCallbacks = {
  onOperation: (operation: DocumentOperation) => void;
  onConflict?: (conflict: CollaborationConflict) => void;
  onPresence: (collaborators: CollaboratorPresence[]) => void;
  onStatus?: (status: 'connecting' | 'connected' | 'closed' | 'error') => void;
};

export type DocumentCollaboration = {
  clientId: string;
  subscribe: () => Promise<void>;
  publishOperation: (operation: Omit<DocumentOperation, 'id' | 'documentId' | 'clientId' | 'sequence' | 'createdAt'>) => Promise<void>;
  publishPresence: (presence: Omit<CollaboratorPresence, 'userId' | 'onlineAt'>) => Promise<void>;
  getRevision: () => number;
  dispose: () => Promise<void>;
};

const channelTopic = (documentId: string) => `document:${documentId}`;

export function createDocumentCollaboration(
  client: SupabaseClient,
  documentId: string,
  userId: string,
  email: string | undefined,
  callbacks: CollaborationCallbacks,
): DocumentCollaboration {
  const clientId = crypto.randomUUID();
  let sequence = 0;
  let revision = 0;
  const seenOperations = new Set<string>();
  let channel: RealtimeChannel | null = null;

  const publishPresence = async (presence: Omit<CollaboratorPresence, 'userId' | 'onlineAt'>) => {
    if (!channel) return;
    await channel.track({ userId, email, ...presence, onlineAt: new Date().toISOString() });
  };

  const publishOperation = async (operation: Omit<DocumentOperation, 'id' | 'documentId' | 'clientId' | 'sequence' | 'createdAt'>) => {
    if (!channel) return;
    sequence += 1;
    const next: DocumentOperation = {
      ...operation,
      id: crypto.randomUUID(),
      documentId,
      clientId,
      sequence,
      baseRevision: revision,
      createdAt: new Date().toISOString(),
    };
    revision += 1;
    const persisted = await client.from('document_operations').insert({
      id: next.id,
      document_id: documentId,
      actor_id: userId,
      client_id: clientId,
      client_sequence: next.sequence,
      base_revision: next.baseRevision,
      operation_type: next.type,
      payload: { pages: next.pages, basePages: next.basePages },
    });
    if (persisted.error) throw persisted.error;
    const sent = await channel.send({ type: 'broadcast', event: 'operation', payload: next });
    if (sent !== 'ok') throw new Error('Não foi possível transmitir a alteração aos colaboradores.');
  };

  const subscribe = async () => {
    callbacks.onStatus?.('connecting');
    channel = client.channel(channelTopic(documentId), {
      config: { broadcast: { self: false, ack: true }, presence: { key: userId } },
    });
    channel.on('broadcast', { event: 'operation' }, ({ payload }) => {
      const incoming = payload as DocumentOperation;
      if (!incoming || incoming.clientId === clientId || incoming.documentId !== documentId) return;
      if (seenOperations.has(incoming.id)) return;
      seenOperations.add(incoming.id);
      if (seenOperations.size > 250) seenOperations.delete(seenOperations.values().next().value as string);
      if (incoming.baseRevision < revision) {
        callbacks.onConflict?.({ incoming, localRevision: revision, reason: 'stale-base' });
        return;
      }
      revision = Math.max(revision, incoming.baseRevision + 1);
      callbacks.onOperation(incoming);
    });
    channel.on('presence', { event: 'sync' }, () => {
      if (!channel) return;
      const state = channel.presenceState<CollaboratorPresence>();
      const collaborators = Object.values(state).flat().filter((item) => item.userId !== userId);
      callbacks.onPresence(collaborators);
    });
    channel.on('presence', { event: 'join' }, () => {
      if (!channel) return;
      const state = channel.presenceState<CollaboratorPresence>();
      callbacks.onPresence(Object.values(state).flat().filter((item) => item.userId !== userId));
    });
    channel.on('presence', { event: 'leave' }, () => {
      if (!channel) return;
      const state = channel.presenceState<CollaboratorPresence>();
      callbacks.onPresence(Object.values(state).flat().filter((item) => item.userId !== userId));
    });
    const result = await new Promise<string>((resolve) => channel?.subscribe((status) => resolve(status)));
    if (result !== 'SUBSCRIBED') {
      callbacks.onStatus?.('error');
      throw new Error('Não foi possível conectar a colaboração em tempo real.');
    }
    callbacks.onStatus?.('connected');
    await publishPresence({ page: 0, selection: null });
  };

  const dispose = async () => {
    if (!channel) return;
    callbacks.onStatus?.('closed');
    await client.removeChannel(channel);
    channel = null;
  };

  return { clientId, subscribe, publishOperation, publishPresence, getRevision: () => revision, dispose };
}
