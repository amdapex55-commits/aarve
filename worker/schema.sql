CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS colours (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, hex TEXT NOT NULL,
  stock INTEGER NOT NULL DEFAULT 0, available INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT UNIQUE,
  idem_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'new',
  pay_status TEXT NOT NULL DEFAULT 'unpaid',
  name TEXT NOT NULL, phone TEXT NOT NULL, city TEXT NOT NULL, address TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '', country TEXT NOT NULL DEFAULT 'PK',
  subtotal INTEGER NOT NULL, shipping INTEGER NOT NULL, total INTEGER NOT NULL,
  courier TEXT NOT NULL DEFAULT '', tracking TEXT NOT NULL DEFAULT '', admin_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS orders_status ON orders(status, id DESC);
CREATE INDEX IF NOT EXISTS orders_phone ON orders(phone);
CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL, colour_id TEXT NOT NULL, colour_name TEXT NOT NULL,
  qty INTEGER NOT NULL, unit_price INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS items_order ON order_items(order_id);
CREATE TABLE IF NOT EXISTS order_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL,
  at TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS events_order ON order_events(order_id, id);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
  contact TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, handled INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS rate (bucket TEXT NOT NULL, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS rate_bucket ON rate(bucket, at);

INSERT OR IGNORE INTO settings(key,value) VALUES
 ('product_name','AARVE MAG/01 Magnetic Pull-Lift Wallet'),
 ('price','5500'),
 ('shipping_fee','0'),
 ('announcement','Launch batch. Cash on delivery across Pakistan.'),
 ('delivery_text','Delivered in 2 to 5 working days'),
 ('max_qty','5');
INSERT OR IGNORE INTO colours(id,name,hex,stock,available,sort) VALUES ('obsidian','Obsidian','#121110',100,1,0);
