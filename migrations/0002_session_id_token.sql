-- Migration number: 0002 	 session id_token
-- Store the OIDC id_token so logout can perform RP-initiated end-session
-- (id_token_hint) against Southbag Identity™, terminating the SSO session too.
ALTER TABLE sessions ADD COLUMN id_token TEXT;
