import { createHash } from 'node:crypto';
import type {
  CollaborationReviewComment,
  CollaborationReviewTarget,
  CollaborationReviewVersion,
  PreviewAnnotationStyle,
  PreviewCommentReviewSource,
  PreviewCommentTarget,
  PreviewCommentUpsertRequest,
} from '@open-design/contracts';

export interface ProjectedReviewCommentInput extends PreviewCommentUpsertRequest {
  id: string;
  reviewSource: PreviewCommentReviewSource;
}

export function projectCollaborationReviewComment(input: {
  serverOrigin: string;
  remoteProjectId: string;
  conversationId: string;
  version: CollaborationReviewVersion;
  comment: CollaborationReviewComment;
}): ProjectedReviewCommentInput {
  const identity = `${input.serverOrigin}\0${input.remoteProjectId}\0${input.version.id}\0${input.comment.id}\0${input.conversationId}`;
  const digest = createHash('sha256').update(identity).digest('hex');
  return {
    id: `review_${digest.slice(0, 32)}`,
    target: projectTarget(input.comment.target, digest, input.version.number),
    note: input.comment.note,
    reviewSource: {
      kind: 'collaboration-review',
      remoteProjectId: input.remoteProjectId,
      remoteVersionId: input.version.id,
      remoteVersionNumber: input.version.number,
      remoteCommentId: input.comment.id,
      remoteCommentRevision: input.comment.revision,
      authorUserId: input.comment.authorUserId,
      source: input.comment.source,
      ...(input.comment.agent
        ? {
            agent: {
              name: input.comment.agent.name,
              ...(input.comment.agent.model ? { model: input.comment.agent.model } : {}),
              ...(input.comment.agent.reviewRunId
                ? { reviewRunId: input.comment.agent.reviewRunId }
                : {}),
            },
          }
        : {}),
      status: input.comment.status,
      targetSelectionKind: input.comment.target.selectionKind,
      targetPosition: input.comment.target.position,
    },
  };
}

function projectTarget(
  target: CollaborationReviewTarget,
  digest: string,
  versionNumber: number,
): PreviewCommentTarget {
  const selectionKind = target.selectionKind === 'pod' ? 'pod' : 'element';
  const podMembers = target.selectionKind === 'pod'
    ? target.podMembers?.map((member, index) => ({
        elementId: `review-member-${digest.slice(index * 4, index * 4 + 12)}`,
        selector: member.selector,
        label: member.label ?? member.selector,
        text: member.currentText ?? '',
        position: member.position,
        htmlHint: '',
        ...(member.style ? { style: definedStyle(member.style) } : {}),
      }))
    : undefined;
  return {
    filePath: localProjectPath(target.filePath),
    elementId: target.elementId?.trim() || `review-point-${digest.slice(0, 12)}`,
    selector: target.selector?.trim() || 'html',
    label: target.label?.trim() || 'Review feedback',
    text: target.currentText ?? '',
    position: target.position,
    htmlHint: target.htmlHint ?? '',
    ...(target.style ? { style: definedStyle(target.style) } : {}),
    selectionKind,
    ...(podMembers?.length ? { memberCount: podMembers.length, podMembers } : {}),
    ...(target.slideIndex === undefined ? {} : { slideIndex: target.slideIndex }),
    anchoredVersion: versionNumber,
  };
}

function localProjectPath(remotePath: string): string {
  return remotePath.startsWith('preview/') ? remotePath.slice('preview/'.length) : remotePath;
}

function definedStyle(style: CollaborationReviewTarget['style']): PreviewAnnotationStyle {
  return Object.fromEntries(
    Object.entries(style ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}
