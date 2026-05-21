import type { LarkChannel } from '@larksuiteoapi/node-sdk';

const WORKING_EMOJI = 'PROCESSING';

export async function addWorkingReaction(
  channel: LarkChannel,
  messageId: string,
): Promise<string | undefined> {
  try {
    const resp = await channel.rawClient.im.v1.messageReaction.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: WORKING_EMOJI } },
    });
    return (resp as any)?.data?.reaction_id;
  } catch {
    return undefined;
  }
}

export async function removeReaction(
  channel: LarkChannel,
  messageId: string,
  reactionId: string,
): Promise<void> {
  try {
    await channel.rawClient.im.v1.messageReaction.delete({
      path: { message_id: messageId, reaction_id: reactionId },
    });
  } catch {}
}
