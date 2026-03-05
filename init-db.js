/**
 * DB 초기화 스크립트 (재생성 버전)
 * 기존 테이블 삭제 후 다시 생성
 */

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function initDB() {
  const client = await pool.connect();
  
  try {
    console.log('🔧 기존 테이블 삭제 후 재생성...\n');

    // 기존 테이블 삭제
    await client.query('DROP TABLE IF EXISTS oy_products CASCADE');
    await client.query('DROP TABLE IF EXISTS oy_collection_batches CASCADE');
    console.log('🗑️ 기존 테이블 삭제 완료');

    // 1. 수집 배치 테이블
    await client.query(`
      CREATE TABLE oy_collection_batches (
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
    console.log('✅ oy_collection_batches 테이블 생성 완료');

    // 2. 제품 데이터 테이블
    await client.query(`
      CREATE TABLE oy_products (
        id SERIAL PRIMARY KEY,
        batch_id INTEGER REFERENCES oy_collection_batches(id) ON DELETE CASCADE,
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
    console.log('✅ oy_products 테이블 생성 완료');

    // 3. 인덱스 생성 (하나씩)
    const indexes = [
      ['idx_oy_products_collected_at', 'CREATE INDEX idx_oy_products_collected_at ON oy_products(collected_at)'],
      ['idx_oy_products_batch_id', 'CREATE INDEX idx_oy_products_batch_id ON oy_products(batch_id)'],
      ['idx_oy_products_big_category', 'CREATE INDEX idx_oy_products_big_category ON oy_products(big_category)'],
      ['idx_oy_products_small_category', 'CREATE INDEX idx_oy_products_small_category ON oy_products(small_category)'],
      ['idx_oy_products_brand', 'CREATE INDEX idx_oy_products_brand ON oy_products(brand)'],
      ['idx_oy_products_rank', 'CREATE INDEX idx_oy_products_rank ON oy_products(rank)'],
      ['idx_oy_batches_collected_at', 'CREATE INDEX idx_oy_batches_collected_at ON oy_collection_batches(collected_at DESC)']
    ];

    for (const [name, sql] of indexes) {
      await client.query(sql);
      console.log(`  ✅ ${name}`);
    }
    console.log('✅ 인덱스 7개 생성 완료');

    // 확인
    const tables = await client.query(`
      SELECT table_name FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_name LIKE 'oy_%'
      ORDER BY table_name;
    `);
    
    const columns = await client.query(`
      SELECT column_name, data_type FROM information_schema.columns 
      WHERE table_name = 'oy_products' ORDER BY ordinal_position;
    `);
    
    console.log('\n📋 생성된 테이블:');
    tables.rows.forEach(r => console.log(`   - ${r.table_name}`));
    
    console.log('\n📋 oy_products 컬럼:');
    columns.rows.forEach(r => console.log(`   - ${r.column_name} (${r.data_type})`));
    
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
