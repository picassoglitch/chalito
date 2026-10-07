-- Neck pieces (store): a new cosmetic slot, `neck`, for bow ties, collars and necklaces placed on
-- each character's detected neck point (card.json anchors.neck; catalog.yaml, slot: neck).
-- Equipping stays POST /v1/store/equip writing companions.equipped = {"<slot>": "<cosmetic id>"},
-- one item per slot, and the companion_directory trigger carries the ids to room co-members.
-- Nothing else in the schema names slots; the only change is room in the directory's equipped list
-- for the eighth slot.

alter table chalito.companion_directory drop constraint if exists companion_directory_equipped_check;
alter table chalito.companion_directory
  add constraint companion_directory_equipped_check
    check (cardinality(equipped) <= 8 and array_to_string(equipped, ',') ~ '^([a-z0-9_]{1,64}(,[a-z0-9_]{1,64})*)?$');
