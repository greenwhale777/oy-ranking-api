/**
 * 올리브영 랭킹 API 서비스
 * 
 * API 목록:
 *   POST /api/oy/upload          - enricher 완료 후 DB 저장
 *   GET  /api/oy/products        - 제품 조회 (필터링/검색/페이지네이션)
 *   GET  /api/oy/batches         - 수집 이력 목록
 *   GET  /api/oy/export          - 엑셀 다운로드
 *   GET  /api/oy/ranking-changes - 순위 변동 조회
 *   GET  /api/oy/stats           - 통계 요약
 *   GET  /health                 - 헬스체크
 */

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const ExcelJS = require('exceljs');

const app = express();
const PORT = process.env.PORT || 3000;

// DB 연결
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 10
});

// 미들웨어
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ============================================================
// 헬스체크
// ============================================================
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', service: 'oy-ranking-api', timestamp: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

// ============================================================
// POST /api/oy/upload - enricher 완료 데이터 DB 저장
// ============================================================
app.post('/api/oy/upload', async (req, res) => {
  const client = await pool.connect();
  
  try {
    const { date, products, duration_minutes } = req.body;
    
    if (!date || !products || !Array.isArray(products)) {
      return res.status(400).json({ success: false, error: 'date와 products 배열이 필요합니다.' });
    }

    console.log(`📦 데이터 업로드: ${date}, ${products.length}개 제품`);

    await client.query('BEGIN');

    // 기존 같은 날짜 데이터 삭제 (재실행 대응)
    const existingBatch = await client.query(
      'SELECT id FROM oy_ranking_batches WHERE collected_at = $1', [date]
    );
    
    if (existingBatch.rows.length > 0) {
      const oldBatchId = existingBatch.rows[0].id;
      await client.query('DELETE FROM oy_ranking_products WHERE batch_id = $1', [oldBatchId]);
      await client.query('DELETE FROM oy_ranking_batches WHERE id = $1', [oldBatchId]);
      console.log(`  🔄 기존 ${date} 데이터 삭제 후 재업로드`);
    }

    // 배치 생성
    const batchResult = await client.query(
      `INSERT INTO oy_ranking_batches (collected_at, total_products, category_count, duration_minutes)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [date, products.length, 18, duration_minutes || null]
    );
    const batchId = batchResult.rows[0].id;

    // 제품 데이터 bulk insert (100개씩 배치)
    const CHUNK_SIZE = 100;
    let inserted = 0;

    for (let i = 0; i < products.length; i += CHUNK_SIZE) {
      const chunk = products.slice(i, i + CHUNK_SIZE);
      
      const values = [];
      const placeholders = [];
      let paramIdx = 1;

      for (const p of chunk) {
        placeholders.push(`($${paramIdx}, $${paramIdx+1}, $${paramIdx+2}, $${paramIdx+3}, $${paramIdx+4}, $${paramIdx+5}, $${paramIdx+6}, $${paramIdx+7}, $${paramIdx+8}, $${paramIdx+9}, $${paramIdx+10}, $${paramIdx+11})`);
        values.push(
          batchId,
          date,
          p.bigCategory || p.big_category || '',
          p.midCategory || p.mid_category || '',
          p.smallCategory || p.small_category || '',
          p.rank || 0,
          p.brand || '',
          p.productName || p.product_name || p.name || '',
          p.price || '',
          p.productUrl || p.product_url || '',
          p.manufacturer || p.manufacturerFullInfo || null,
          p.ingredients || null
        );
        paramIdx += 12;
      }

      await client.query(
        `INSERT INTO oy_ranking_products (batch_id, collected_at, big_category, mid_category, small_category, rank, brand, product_name, price, product_url, manufacturer, ingredients)
         VALUES ${placeholders.join(', ')}`,
        values
      );
      inserted += chunk.length;
    }

    await client.query('COMMIT');

    console.log(`✅ 업로드 완료: batch_id=${batchId}, ${inserted}개 제품`);
    res.json({ success: true, batchId, inserted });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ 업로드 실패:', error.message);
    res.status(500).json({ success: false, error: error.message });
  } finally {
    client.release();
  }
});

// ============================================================
// GET /api/oy/products - 제품 조회
// 쿼리 파라미터: date, bigCategory, smallCategory, search, page, limit
// ============================================================
app.get('/api/oy/products', async (req, res) => {
  try {
    const {
      date,
      bigCategory,
      smallCategory,
      search,
      page = 1,
      limit = 50
    } = req.query;

    const conditions = [];
    const params = [];
    let paramIdx = 1;

    // 날짜 필터 (없으면 최신 배치)
    if (date) {
      conditions.push(`p.collected_at = $${paramIdx++}`);
      params.push(date);
    } else {
      conditions.push(`p.collected_at = (SELECT MAX(collected_at) FROM oy_ranking_batches)`);
    }

    if (bigCategory) {
      conditions.push(`p.big_category = $${paramIdx++}`);
      params.push(bigCategory);
    }

    if (smallCategory) {
      conditions.push(`p.small_category = $${paramIdx++}`);
      params.push(smallCategory);
    }

    if (search) {
      conditions.push(`(p.brand ILIKE $${paramIdx} OR p.product_name ILIKE $${paramIdx})`);
      params.push(`%${search}%`);
      paramIdx++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const offset = (parseInt(page) - 1) * parseInt(limit);

    // 총 개수
    const countResult = await pool.query(
      `SELECT COUNT(*) as total FROM oy_ranking_products p ${whereClause}`, params
    );
    const total = parseInt(countResult.rows[0].total);

    // 제품 데이터
    const dataParams = [...params, parseInt(limit), offset];
    const dataResult = await pool.query(
      `SELECT p.*, b.collected_at as batch_date
       FROM oy_ranking_products p
       JOIN oy_ranking_batches b ON p.batch_id = b.id
       ${whereClause}
       ORDER BY p.big_category, p.small_category, p.rank
       LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
      dataParams
    );

    res.json({
      success: true,
      data: dataResult.rows,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        totalPages: Math.ceil(total / parseInt(limit))
      }
    });

  } catch (error) {
    console.error('❌ 제품 조회 실패:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================
// GET /api/oy/batches - 수집 이력 목록
// ============================================================
app.get('/api/oy/batches', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT b.*, 
              (SELECT COUNT(DISTINCT small_category) FROM oy_ranking_products WHERE batch_id = b.id) as actual_categories
       FROM oy_ranking_batches b
       ORDER BY b.collected_at DESC
       LIMIT 52`
    );

    res.json({ success: true, data: result.rows });

  } catch (error) {
    console.error('❌ 배치 조회 실패:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================
// GET /api/oy/ranking-changes - 순위 변동 (이전 수집 대비)
// 쿼리 파라미터: date, bigCategory, smallCategory
// ============================================================
app.get('/api/oy/ranking-changes', async (req, res) => {
  try {
    const { date, bigCategory, smallCategory } = req.query;

    // 현재 날짜 (없으면 최신)
    let currentDate = date;
    if (!currentDate) {
      const latest = await pool.query('SELECT MAX(collected_at) as d FROM oy_ranking_batches');
      currentDate = latest.rows[0]?.d;
      if (!currentDate) return res.json({ success: true, data: [] });
    }

    // 이전 수집 날짜 찾기
    const prevResult = await pool.query(
      `SELECT MAX(collected_at) as d FROM oy_ranking_batches WHERE collected_at < $1`,
      [currentDate]
    );
    const prevDate = prevResult.rows[0]?.d;

    if (!prevDate) {
      // 이전 데이터 없으면 현재 데이터만 반환 (변동 없음)
      return res.json({ success: true, data: [], message: '이전 수집 데이터 없음' });
    }

    // 카테고리 필터
    const conditions = [];
    const params = [currentDate, prevDate];
    let paramIdx = 3;

    if (bigCategory) {
      conditions.push(`curr.big_category = $${paramIdx++}`);
      params.push(bigCategory);
    }
    if (smallCategory) {
      conditions.push(`curr.small_category = $${paramIdx++}`);
      params.push(smallCategory);
    }

    const extraWhere = conditions.length > 0 ? `AND ${conditions.join(' AND ')}` : '';

    const result = await pool.query(`
      SELECT 
        curr.big_category,
        curr.mid_category,
        curr.small_category,
        curr.rank as current_rank,
        curr.brand,
        curr.product_name,
        curr.price,
        curr.product_url,
        prev.rank as previous_rank,
        CASE 
          WHEN prev.rank IS NULL THEN 'NEW'
          WHEN prev.rank > curr.rank THEN 'UP'
          WHEN prev.rank < curr.rank THEN 'DOWN'
          ELSE 'SAME'
        END as change_type,
        CASE 
          WHEN prev.rank IS NOT NULL THEN prev.rank - curr.rank
          ELSE NULL
        END as rank_change
      FROM oy_ranking_products curr
      LEFT JOIN oy_ranking_products prev 
        ON curr.product_url = prev.product_url 
        AND curr.small_category = prev.small_category
        AND prev.collected_at = $2
      WHERE curr.collected_at = $1 ${extraWhere}
      ORDER BY curr.big_category, curr.small_category, curr.rank
    `, params);

    res.json({
      success: true,
      currentDate,
      previousDate: prevDate,
      data: result.rows
    });

  } catch (error) {
    console.error('❌ 순위 변동 조회 실패:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================
// GET /api/oy/stats - 통계 요약
// ============================================================
app.get('/api/oy/stats', async (req, res) => {
  try {
    const { date } = req.query;

    let targetDate = date;
    if (!targetDate) {
      const latest = await pool.query('SELECT MAX(collected_at) as d FROM oy_ranking_batches');
      targetDate = latest.rows[0]?.d;
      if (!targetDate) return res.json({ success: true, data: null });
    }

    // 카테고리별 제품 수
    const categoryStats = await pool.query(`
      SELECT big_category, small_category, COUNT(*) as count, MAX(rank) as max_rank
      FROM oy_ranking_products 
      WHERE collected_at = $1
      GROUP BY big_category, small_category
      ORDER BY big_category, small_category
    `, [targetDate]);

    // 대카테고리별 합계
    const bigCategoryStats = await pool.query(`
      SELECT big_category, COUNT(*) as count
      FROM oy_ranking_products 
      WHERE collected_at = $1
      GROUP BY big_category
      ORDER BY big_category
    `, [targetDate]);

    // 총 브랜드 수
    const brandCount = await pool.query(`
      SELECT COUNT(DISTINCT brand) as count
      FROM oy_ranking_products 
      WHERE collected_at = $1
    `, [targetDate]);

    // 총 제품 수
    const totalProducts = await pool.query(`
      SELECT COUNT(*) as count FROM oy_ranking_products WHERE collected_at = $1
    `, [targetDate]);

    res.json({
      success: true,
      date: targetDate,
      totalProducts: parseInt(totalProducts.rows[0].count),
      totalBrands: parseInt(brandCount.rows[0].count),
      bigCategoryStats: bigCategoryStats.rows,
      categoryStats: categoryStats.rows
    });

  } catch (error) {
    console.error('❌ 통계 조회 실패:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================
// GET /api/oy/export - 엑셀 다운로드
// 쿼리 파라미터: date, bigCategory, smallCategory
// ============================================================
app.get('/api/oy/export', async (req, res) => {
  try {
    const { date, bigCategory, smallCategory } = req.query;

    const conditions = [];
    const params = [];
    let paramIdx = 1;

    if (date) {
      conditions.push(`p.collected_at = $${paramIdx++}`);
      params.push(date);
    } else {
      conditions.push(`p.collected_at = (SELECT MAX(collected_at) FROM oy_ranking_batches)`);
    }

    if (bigCategory) {
      conditions.push(`p.big_category = $${paramIdx++}`);
      params.push(bigCategory);
    }

    if (smallCategory) {
      conditions.push(`p.small_category = $${paramIdx++}`);
      params.push(smallCategory);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await pool.query(
      `SELECT p.* FROM oy_ranking_products p ${whereClause} ORDER BY p.big_category, p.small_category, p.rank`,
      params
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: '데이터가 없습니다.' });
    }

    // 엑셀 생성
    const workbook = new ExcelJS.Workbook();
    
    // 대카테고리별 시트 생성
    const bigCategories = [...new Set(result.rows.map(r => r.big_category))];

    for (const bigCat of bigCategories) {
      const sheet = workbook.addWorksheet(bigCat);
      
      // 헤더
      sheet.columns = [
        { header: '대카테고리', key: 'big_category', width: 12 },
        { header: '중카테고리', key: 'mid_category', width: 15 },
        { header: '소카테고리', key: 'small_category', width: 15 },
        { header: '순위', key: 'rank', width: 8 },
        { header: '브랜드', key: 'brand', width: 18 },
        { header: '상품명', key: 'product_name', width: 45 },
        { header: '가격', key: 'price', width: 12 },
        { header: '상품URL', key: 'product_url', width: 50 },
        { header: '제조업자', key: 'manufacturer', width: 40 },
        { header: '성분', key: 'ingredients', width: 60 }
      ];

      // 헤더 스타일
      sheet.getRow(1).eachCell(cell => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F172A' } };
        cell.font = { color: { argb: 'FFFFFFFF' }, bold: true, size: 10 };
        cell.alignment = { vertical: 'middle', horizontal: 'center' };
      });

      // 데이터
      const catRows = result.rows.filter(r => r.big_category === bigCat);
      catRows.forEach(row => {
        const dataRow = sheet.addRow(row);
        // URL을 하이퍼링크로
        if (row.product_url) {
          const urlCell = dataRow.getCell('product_url');
          urlCell.value = { text: row.product_url, hyperlink: row.product_url };
          urlCell.font = { color: { argb: 'FF0563C1' }, underline: true };
        }
      });

      // 필터 설정
      sheet.autoFilter = { from: 'A1', to: 'J1' };
    }

    // 전체 시트도 추가
    const allSheet = workbook.addWorksheet('전체');
    allSheet.columns = [
      { header: '대카테고리', key: 'big_category', width: 12 },
      { header: '중카테고리', key: 'mid_category', width: 15 },
      { header: '소카테고리', key: 'small_category', width: 15 },
      { header: '순위', key: 'rank', width: 8 },
      { header: '브랜드', key: 'brand', width: 18 },
      { header: '상품명', key: 'product_name', width: 45 },
      { header: '가격', key: 'price', width: 12 },
      { header: '상품URL', key: 'product_url', width: 50 },
      { header: '제조업자', key: 'manufacturer', width: 40 },
      { header: '성분', key: 'ingredients', width: 60 }
    ];
    allSheet.getRow(1).eachCell(cell => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F172A' } };
      cell.font = { color: { argb: 'FFFFFFFF' }, bold: true, size: 10 };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
    });
    result.rows.forEach(row => {
      const dataRow = allSheet.addRow(row);
      if (row.product_url) {
        const urlCell = dataRow.getCell('product_url');
        urlCell.value = { text: row.product_url, hyperlink: row.product_url };
        urlCell.font = { color: { argb: 'FF0563C1' }, underline: true };
      }
    });
    allSheet.autoFilter = { from: 'A1', to: 'J1' };

    // 응답
    const exportDate = result.rows[0].collected_at?.toISOString?.()?.slice(0, 10) || date || 'latest';
    const filename = `올리브영_랭킹_${exportDate}.xlsx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);

    await workbook.xlsx.write(res);
    res.end();

    console.log(`📥 엑셀 다운로드: ${filename} (${result.rows.length}개 제품)`);

  } catch (error) {
    console.error('❌ 엑셀 생성 실패:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================
// 서버 시작
// ============================================================
app.listen(PORT, async () => {
  console.log(`🚀 oy-ranking-api 서버 시작 (포트: ${PORT})`);
  console.log(`📋 API 목록:`);
  console.log(`   POST /api/oy/upload          - 데이터 업로드`);
  console.log(`   GET  /api/oy/products        - 제품 조회`);
  console.log(`   GET  /api/oy/batches         - 수집 이력`);
  console.log(`   GET  /api/oy/ranking-changes - 순위 변동`);
  console.log(`   GET  /api/oy/stats           - 통계`);
  console.log(`   GET  /api/oy/export          - 엑셀 다운로드`);
  console.log(`   GET  /health                 - 헬스체크`);

  // DB 연결 확인
  try {
    const result = await pool.query('SELECT NOW()');
    console.log(`✅ DB 연결 성공: ${result.rows[0].now}`);
    
    // 테이블 존재 확인
    const tables = await pool.query(`
      SELECT table_name FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_name LIKE 'oy_ranking_%'
    `);
    
    if (tables.rows.length === 0) {
      console.log('⚠️ oy_ranking_ 테이블이 없습니다. init-db.js를 먼저 실행하세요.');
    } else {
      console.log(`📊 oy_ranking_ 테이블 ${tables.rows.length}개 확인됨`);
    }
  } catch (e) {
    console.error('❌ DB 연결 실패:', e.message);
  }
});
