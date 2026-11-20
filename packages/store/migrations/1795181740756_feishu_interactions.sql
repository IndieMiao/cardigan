-- Private host state. No SDK envelopes, forms, secrets, codes or message content.
CREATE TABLE feishu_runtime(id INTEGER PRIMARY KEY CHECK(id=1), scope TEXT NOT NULL, state TEXT NOT NULL, heartbeat INTEGER NOT NULL, code_ttl INTEGER NOT NULL DEFAULT 300000);
CREATE TABLE feishu_codes(scope TEXT PRIMARY KEY, member TEXT NOT NULL, digest TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE feishu_bindings(scope TEXT PRIMARY KEY, generation TEXT NOT NULL UNIQUE, member TEXT NOT NULL, open_id TEXT NOT NULL, chat TEXT NOT NULL);
CREATE TABLE feishu_cards(ref TEXT PRIMARY KEY, send_key TEXT NOT NULL UNIQUE, binding TEXT NOT NULL, project TEXT NOT NULL, item_kind TEXT NOT NULL, item TEXT NOT NULL, version TEXT NOT NULL, choices TEXT NOT NULL, expires INTEGER NOT NULL, message TEXT UNIQUE, state TEXT NOT NULL DEFAULT 'open', receipt INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0);
CREATE INDEX feishu_receipts ON feishu_cards(receipt,retry_at);
CREATE TABLE feishu_events(scope TEXT NOT NULL, event TEXT NOT NULL, PRIMARY KEY(scope,event));
CREATE TABLE feishu_audit(id INTEGER PRIMARY KEY, at INTEGER NOT NULL, result TEXT NOT NULL, member TEXT, ref TEXT);
CREATE INDEX feishu_claimed ON feishu_cards(state) WHERE state='claimed';
