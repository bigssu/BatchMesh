# BatchMesh — Meshy 캐릭터 시트 배치 파이프라인

캐릭터 시트(턴어라운드) 이미지를 넣으면 뷰를 자동 분해하고, 검수 후 Meshy API로 3D 모델을 생성하는 로컬 웹 도구.

## 준비

```
npm install
```

- `.env`에 `MESHY_API_KEY=msy_...` (`.env.example` 참고)
- 환경변수 `GOOGLE_API_KEY` — 시트 자동 분해(Gemini 비전) 및 2K 업스케일용

## 사용

```
node server.mjs      →  http://localhost:3838
```

1. **시트 드래그** → front/left/back/right/face 자동 크롭 (전신 1장만 넣으면 싱글 이미지 모드)
2. **검수** — 크롭별 삭제(✕) / 2K 업스케일 / 힌트 재분해, 이미지 위 📂 폴더 열기·📋 경로 복사
3. **승인 → 3D 생성 시작** — 하이폴리 생성, 진행률 카드 표시
4. **로우폴리 추출** — 완성 버전에서 원하는 폴리곤 수로 추출(원본 하이폴리 기준이라 반복 추출해도 품질 유지)
5. 결과는 `output/<id>/gen-<일시>/`에 버전별로 축적. 카드의 소형 3D 뷰어(풀 쉐이딩/클레이/와이어/조명), 히스토리 보관 지원

**기하 먼저 검수 모드**(옵션): 텍스처 없이 기하만 생성(크레딧 절약) → 형상 확인 → "텍스처 입히기"로 마감.

## CLI

```
node scripts/run_batch.mjs --dry-run     # 매칭 확인만
node scripts/run_batch.mjs --only id1,id2 --force
node scripts/split_sheet.mjs <sheet.png> <outDir> [힌트]
```

크롭을 직접 넣을 때는 `input/<캐릭터id>/front.png` (left/back/right/face) 규약을 따른다.

## 메모

- 생성 옵션은 `config.json`에 고정되며 웹 UI에서 편집 (모든 캐릭터에 동일 적용)
- Meshy 결과 URL은 3일 후 만료 — 러너가 완료 즉시 로컬 저장
- `input/` `output/` `staging/` `history/` `logs/`는 데이터 폴더라 git에서 제외
