-- Skins (store): a new cosmetic slot, `skin`, for a material effect drawn over the whole companion
-- by the card renderer (gold, galaxy, neon…; catalog.yaml, slot: skin). Equipping stays
-- POST /v1/store/equip writing companions.equipped = {"<slot>": "<cosmetic id>"}, so a companion
-- wears at most one skin (one key per slot) and the companion_directory trigger carries it to
-- room co-members with the other equipped ids. Nothing else in the schema names slots; the only
-- change is room in the directory's equipped list for the seventh slot.

alter table chalito.companion_directory drop constraint if exists companion_directory_equipped_check;
alter table chalito.companion_directory
  add constraint companion_directory_equipped_check
    check (cardinality(equipped) <= 7 and array_to_string(equipped, ',') ~ '^([a-z0-9_]{1,64}(,[a-z0-9_]{1,64})*)?$');
