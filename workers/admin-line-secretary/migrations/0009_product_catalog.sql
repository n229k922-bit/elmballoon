CREATE TABLE IF NOT EXISTS product_catalog (
  id TEXT PRIMARY KEY,
  product_number TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT,
  product_url TEXT,
  image_url TEXT NOT NULL,
  image_alt TEXT,
  status TEXT NOT NULL CHECK (status IN ('published', 'archived')) DEFAULT 'published',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS product_catalog_number_idx
  ON product_catalog(product_number);

CREATE INDEX IF NOT EXISTS product_catalog_status_idx
  ON product_catalog(status, product_number);

INSERT OR IGNORE INTO product_catalog
  (id, product_number, name, category, product_url, image_url, image_alt, status, created_at, updated_at)
VALUES
  ('product:arrangement:31', '31', 'バルーンアレンジ㉛', 'バルーンアレンジ', 'https://elmballoon.com/item/item-1143/', 'https://elmballoon.com/wp/wp-content/uploads/2020/05/69185a77ba2fc02bf1230683e3964084-e1590553177100.jpg', 'バルーンアレンジ31', 'published', datetime('now'), datetime('now')),
  ('product:arrangement:32', '32', 'バルーンアレンジ㉜', 'バルーンアレンジ', 'https://elmballoon.com/item/item-1144/', 'https://elmballoon.com/wp/wp-content/uploads/2020/05/f30599e21da57bd5b55e4cbedc934b09-e1590553323519.jpg', 'バルーンアレンジ32', 'published', datetime('now'), datetime('now')),
  ('product:arrangement:33', '33', 'バルーンアレンジ㉝', 'バルーンアレンジ', 'https://elmballoon.com/item/item-1446/', 'https://elmballoon.com/wp/wp-content/uploads/2021/04/B54006E4-0BC0-4B04-B32D-4250C29334E7.jpeg', 'バルーンアレンジ33', 'published', datetime('now'), datetime('now')),
  ('product:arrangement:34', '34', 'バルーンアレンジ㉞', 'バルーンアレンジ', 'https://elmballoon.com/item/item-1447/', 'https://elmballoon.com/wp/wp-content/uploads/2021/04/96DCCE1F-8BA1-409A-83E3-FB0D55A62DF0.jpeg', 'バルーンアレンジ34', 'published', datetime('now'), datetime('now')),
  ('product:arrangement:35', '35', 'バルーンアレンジ㉟', 'バルーンアレンジ', 'https://elmballoon.com/item/item-1448/', 'https://elmballoon.com/wp/wp-content/uploads/2021/04/DC950DC8-A766-4F27-8F32-56715FA68F94.jpeg', 'バルーンアレンジ35', 'published', datetime('now'), datetime('now')),
  ('product:arrangement:36', '36', 'バルーンアレンジ㊱', 'バルーンアレンジ', 'https://elmballoon.com/item/item-1451/', 'https://elmballoon.com/wp/wp-content/uploads/2021/04/FB7870E4-AC28-4225-A048-C4335664174C.jpeg', 'バルーンアレンジ36', 'published', datetime('now'), datetime('now'));
