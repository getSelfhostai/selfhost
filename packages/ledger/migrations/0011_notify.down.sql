-- Rolls back 0011_notify.sql. Every notification target, digest setting and send record is
-- dropped: after upgrading again, people add their targets again with selfhost notify add.
DROP TABLE notify_sends;
DROP TABLE notify_settings;
DROP TABLE notify_targets;
