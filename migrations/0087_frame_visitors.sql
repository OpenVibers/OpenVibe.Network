-- phase: expand
-- Distinct visitors per site and day (11-16; the owner on openvibe.report/stats: "a lot of these stats and metrics aren't
-- working": every site but Live showed Visitors —). A visitor is an HMAC of the day's random salt over the address, the
-- browser and the host: the salt changes every day and is never kept past it, so nothing here can be joined to a person
-- or to another day. The day's hashes are rolled into a count and deleted once the day is over (server/frame/visitors.js).
CREATE TABLE IF NOT EXISTS frame_visitors (
    day text COLLATE "C" NOT NULL,
    host text COLLATE "C" NOT NULL,
    v text COLLATE "C" NOT NULL,
    PRIMARY KEY (day, host, v)
);
CREATE TABLE IF NOT EXISTS frame_visitor_days (
    day text COLLATE "C" NOT NULL,
    host text COLLATE "C" NOT NULL,
    visitors bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (day, host)
);
