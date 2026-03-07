/**
 * DB 초기화 스크립트
 * Railway PostgreSQL에 올리브영 랭킹 테이블 생성
 * 
 * 실행: node init-db.js
 * 환경변수: DATABASE_URL (Railway에서 자동 제공)
 */

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function initDB() {
  const client = await pool.connect();
  
  try {
    console.log('🔧 올리브영 랭킹 테이블 생성 시작...\n');
    console.log('⚠️ 기존 테이블은 건들지 않습니다. oy_ranking_ 접두어만 사용합니다.\n');

    // 1. 수집 배치 테이블
    await client.query(`
      CREATE TABLE IF NOT EXISTS oy_ranking_batches (
        id SERIAL PRIMARY KEY,
        collected_at DATE NOT NULL,
        total_products INTEGER DEFAULT 0,
        category_count INTEGER DEFAULT 18,
        status VARCHAR(20) DEFAULT 'completed',
        duration_minutes DECIMAL(5,1),
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(collected_at)
      );
    `);
    console.log('✅ oy_ranking_batches 테이블 생성 완료');

    // 2. 제품 데이터 테이블
    await client.query(`
      CREATE TABLE IF NOT EXISTS oy_ranking_products (
        id SERIAL PRIMARY KEY,
        batch_id INTEGER REFERENCES oy_ranking_batches(id) ON DELETE CASCADE,
        collected_at DATE NOT NULL,
        big_category VARCHAR(20) NOT NULL,
        mid_category VARCHAR(30) NOT NULL,
        small_category VARCHAR(30) NOT NULL,
        rank INTEGER NOT NULL,
        brand VARCHAR(200),
        product_name VARCHAR(500),
        price VARCHAR(50),
        product_url TEXT,
        manufacturer TEXT,
        ingredients TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('✅ oy_ranking_products 테이블 생성 완료');

    // 3. 인덱스 생성
    const indexes = [
      'CREATE INDEX IF NOT EXISTS idx_oy_ranking_products_collected_at ON oy_ranking_products(collected_at)',
      'CREATE INDEX IF NOT EXISTS idx_oy_ranking_products_batch_id ON oy_ranking_products(batch_id)',
      'CREATE INDEX IF NOT EXISTS idx_oy_ranking_products_big_category ON oy_ranking_products(big_category)',
      'CREATE INDEX IF NOT EXISTS idx_oy_ranking_products_small_category ON oy_ranking_products(small_category)',
      'CREATE INDEX IF NOT EXISTS idx_oy_ranking_products_brand ON oy_ranking_products(brand)',
      'CREATE INDEX IF NOT EXISTS idx_oy_ranking_products_rank ON oy_ranking_products(rank)',
      'CREATE INDEX IF NOT EXISTS idx_oy_ranking_batches_collected_at ON oy_ranking_batches(collected_at DESC)'
    ];

    for (const idx of indexes) {
      await client.query(idx);
    }
    console.log('✅ 인덱스 7개 생성 완료');

    // 확인
    const tables = await client.query(`
      SELECT table_name FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_name LIKE 'oy_ranking_%'
      ORDER BY table_name;
    `);
    
    console.log('\n📋 생성된 테이블:');
    tables.rows.forEach(r => console.log(`   - ${r.table_name}`));
    
    console.log('\n🎉 DB 초기화 완료!');

  } catch (error) {
    console.error('❌ DB 초기화 실패:', error.message);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

initDB().catch(err => {
  console.error(err);
  process.exit(1);
});
