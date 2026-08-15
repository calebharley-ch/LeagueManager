-- ============================================================================
--  017 - an invite that does not need an email address
--
--  Run after 016. Additive and idempotent.
--
--  league_invites started life as an address book: a row existed because the
--  commissioner had somewhere to send an invite. But the token and the code on
--  that row are the credential, and both work perfectly well pasted into a
--  group chat - which is how this league actually talks to itself.
--
--  Requiring an email to mint a link meant the commissioner had to know an
--  address for somebody sitting in the same WhatsApp thread, or type a fake one
--  and leave it in the table forever.
--
--  The column stays. It is now null when nobody has been emailed. Everything
--  that sends mail already filters on a valid-looking address, and invited_at
--  is still the flag for "an email actually went out".
-- ============================================================================

alter table public.league_invites alter column email drop not null;
