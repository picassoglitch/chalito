-- Passkey ↔ device-key bindings (chalito.webauthn-binding.v1): signed by the client's DEVICE
-- key, so agents record the passkey from the same trust root they confirmed at the reverse
-- check (D-019). The api stores the binding with the credential and hands the claimer's to
-- the agent in its pairing code. Both are public, signed data; table-level grants cover them.

alter table chalito.devices add column webauthn_binding jsonb
  check (webauthn_binding is null or jsonb_typeof(webauthn_binding) = 'object');

alter table chalito.pairing_codes add column claimer_webauthn_binding jsonb
  check (claimer_webauthn_binding is null or jsonb_typeof(claimer_webauthn_binding) = 'object');
