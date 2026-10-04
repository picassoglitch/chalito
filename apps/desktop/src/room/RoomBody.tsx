import { useCallback, useState } from "react";
import type { RoomController, RoomMemberView, RoomSnapshot } from "@chalito/rooms";
import type { RoomSceneMember } from "@chalito/scene";
import {
  RoomComposer,
  RoomEnded,
  RoomEventList,
  RoomMembers,
  RoomReportDialog,
  memberLabel,
  useUiText,
  type ReportTarget,
  type RoomEndReason,
} from "@chalito/ui";
import { useT } from "../lib/i18n.js";
import { RoomStage } from "./RoomStage.js";

const ENDED: readonly string[] = ["kicked", "dissolved", "revoked", "not_member"];

/**
 * One room: the scene (metadata only), then the shared packages/ui room components over the
 * controller's snapshot. Event content is only ever quoted text (RoomEventList).
 */
export const RoomBody = ({
  snapshot,
  controller,
  me,
  resolveMembers,
  stage = true,
}: {
  snapshot: RoomSnapshot;
  controller: RoomController;
  /** This person's companion id. */
  me: string;
  resolveMembers: (m: readonly RoomMemberView[]) => Promise<RoomSceneMember[]>;
  /** The 3D/card scene (off in tests without WebGL). */
  stage?: boolean;
}) => {
  const t = useT();
  const { t: ut } = useUiText();
  const [reporting, setReporting] = useState<ReportTarget | null>(null);
  const [left, setLeft] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const ended: RoomEndReason | null = left
    ? "left"
    : ENDED.includes(snapshot.status)
      ? (snapshot.status as RoomEndReason)
      : null;
  const live = snapshot.status === "live" && !ended;

  const send = useCallback(
    async (text: string) => {
      const r = await controller.postNotice(text);
      return r.ok ? null : r.reason;
    },
    [controller],
  );

  return (
    <section className="room" aria-label={snapshot.room?.name ?? t("room.title")}>
      <h1>{snapshot.room?.name ?? t("room.title")}</h1>
      {stage && snapshot.room && (
        <RoomStage
          roomId={snapshot.room.roomId}
          members={snapshot.members}
          events={snapshot.events}
          running={!ended}
          resolveMembers={resolveMembers}
        />
      )}
      {ended && <RoomEnded status={ended} />}
      {snapshot.status === "error" && <p role="alert">{t("room.error.failed")}</p>}
      {notice && <p role="status">{notice}</p>}

      <RoomEventList
        events={snapshot.events.filter((e) => e.kind !== "presence")}
        me={me}
        onReport={(eid) =>
          setReporting({ eventId: eid, text: snapshot.events.find((e) => e.eid === eid)?.text ?? null })
        }
      />
      {snapshot.members.length > 0 && (
        <RoomMembers members={snapshot.members} onReport={(c) => setReporting({ memberCompanionId: c })} />
      )}
      {live && (
        <>
          <RoomComposer onSend={send} />
          <button
            type="button"
            className="link"
            onClick={() => void controller.leave().then((r) => r.ok && setLeft(true))}
          >
            {t("room.leave")}
          </button>
        </>
      )}
      {reporting && (
        <RoomReportDialog
          target={reporting}
          label={reporting.memberCompanionId ? memberLabel(reporting.memberCompanionId, false, ut) : undefined}
          onCancel={() => setReporting(null)}
          onSubmit={async (input) => {
            const r = await controller.report(input);
            setReporting(null);
            setNotice(
              r.ok ? t(r.duplicate ? "room.reported.duplicate" : "room.reported.ok") : t(`room.error.${r.reason}`),
            );
          }}
        />
      )}
    </section>
  );
};
