-- "The provider took it" and "the phone got it" are two different facts.
--
-- The adapter treated Twilio's 201 as delivery. Twilio's 201 means *accepted
-- for sending*; the body can even say `"status":"failed"` alongside it. A
-- message that a carrier then rejects was being recorded as a clean success,
-- which is exactly the defect docs/06-external-services.md gives as the reason
-- for leaving the carrier email gateways: "no delivery confirmation".
--
-- So `sent` now means confirmed by the provider, and a new state sits in front
-- of it. Confirmation arrives later, on a status callback, keyed by the
-- provider's own reference for the message.
ALTER TYPE outbox_state ADD VALUE IF NOT EXISTS 'accepted' BEFORE 'sent';

ALTER TABLE notifications
    -- The provider's id for this message (Twilio's Message SID). How a status
    -- callback finds the row it is about.
    ADD COLUMN IF NOT EXISTS provider_ref text,
    -- When the provider confirmed the handset had it. Distinct from sent_at,
    -- which now records the same moment; kept separate so an import or a
    -- second provider can fill one without the other.
    ADD COLUMN IF NOT EXISTS delivered_at timestamptz,
    -- After this, sending is pointless. A sign-in code is good for ten
    -- minutes, and the retry back-off runs to three hours: without this the
    -- queue would keep trying to deliver a code that expired two hours ago,
    -- and the driver would get a text that cannot sign them in.
    ADD COLUMN IF NOT EXISTS expires_at timestamptz;

-- A status callback arrives with nothing but the provider's reference.
CREATE UNIQUE INDEX IF NOT EXISTS notifications_provider_ref
    ON notifications (provider_ref)
    WHERE provider_ref IS NOT NULL;
