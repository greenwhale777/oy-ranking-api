# oy-ranking-api

올리브영 랭킹 데이터 API 서비스

## Railway 배포 순서

### 1. GitHub 레포 생성 & 푸시
```bash
cd oy-ranking-api
git init
git add .
git commit -m "올리브영 랭킹 API 서비스 초기 구축"
git remote add origin https://github.com/[your-username]/oy-ranking-api.git
git push -u origin main
```

### 2. Railway 서비스 생성
1. Railway 대시보드 → 기존 프로젝트 선택
2. "New Service" → "GitHub Repo" → oy-ranking-api 선택
3. 환경변수 설정:
   - `DATABASE_URL` → 기존 ev2-page-analyzer PostgreSQL의 연결 문자열 복사
   - `NODE_ENV` → `production`

> ⚠️ DATABASE_URL은 기존 ev2-page-analyzer 서비스의 PostgreSQL Variables에서 복사

### 3. 배포 후 DB 초기화
Railway 서비스 배포 완료 후, Railway CLI 또는 콘솔에서:
```bash
railway run node init-db.js
```
또는 Railway 서비스 Shell에서 직접 실행

### 4. 헬스체크 확인
```
https://oy-ranking-api-production.up.railway.app/health
```

### 5. 로컬 PC 설정
`oy-db-uploader.js`를 PC의 `C:\Users\a\my-playwright-project\`에 복사 후,
orchestrator에서 ranking-processor 대신 호출하도록 변경

## API 목록

| 메서드 | 경로 | 설명 |
|--------|------|------|
| POST | /api/oy/upload | enricher CSV → DB 저장 |
| GET | /api/oy/products | 제품 조회 (필터/검색/페이지네이션) |
| GET | /api/oy/batches | 수집 이력 목록 |
| GET | /api/oy/export | 엑셀(xlsx) 다운로드 |
| GET | /api/oy/ranking-changes | 순위 변동 |
| GET | /api/oy/stats | 통계 요약 |

## 환경변수

| 변수 | 설명 |
|------|------|
| DATABASE_URL | PostgreSQL 연결 문자열 |
| PORT | 서버 포트 (Railway 자동 할당) |
| NODE_ENV | production |
