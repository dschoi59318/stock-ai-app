export default {
  async fetch(request, env) {

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        }
      });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    try {
      const body = await request.json();
      const stockName = body.stockName || '';
      const mode = body.mode || 'recommend';
      const userPrompt = body.messages?.[0]?.content || '';

      let realData = { news: [], price: '', dart: '' };

      if (stockName && mode === 'analyze') {

        // 병렬로 뉴스 + 주가 + DART 동시 수집
        const [newsResult, priceResult, dartResult] = await Promise.allSettled([

          // 1. 뉴스 수집 (Claude + 웹검색)
          fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': env.ANTHROPIC_API_KEY,
              'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
              model: 'claude-haiku-4-5-20251001',
              max_tokens: 800,
              tools: [{ type: 'web_search_20250305', name: 'web_search' }],
              messages: [{
                role: 'user',
                content: `"${stockName}" 주식 관련 오늘 최신 뉴스 5개를 검색하고 아래 형식으로만 반환해줘:
1. [제목] | [한줄요약]
2. [제목] | [한줄요약]
3. [제목] | [한줄요약]
4. [제목] | [한줄요약]
5. [제목] | [한줄요약]`
              }]
            })
          }).then(r => r.json()),

          // 2. 실시간 주가 수집 (Claude + 웹검색)
          fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': env.ANTHROPIC_API_KEY,
              'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
              model: 'claude-haiku-4-5-20251001',
              max_tokens: 400,
              tools: [{ type: 'web_search_20250305', name: 'web_search' }],
              messages: [{
                role: 'user',
                content: `${stockName} 현재 주가 PER PBR 시가총액 52주최고 52주최저 배당수익률 검색해서 아래 형식으로만:
현재가: XX원 | PER: XX배 | PBR: XX배 | 시가총액: XX | 52주최고: XX원 | 52주최저: XX원 | 배당: X.X%`
              }]
            })
          }).then(r => r.json()),

          // 3. DART 공시 수집
          fetch(`https://opendart.fss.or.kr/api/company.json?crtfc_key=${env.DART_API_KEY}&corp_name=${encodeURIComponent(stockName)}&page_no=1&page_count=1`)
            .then(r => r.json())
            .then(async data => {
              if (data.list?.[0]) {
                const corpCode = data.list[0].corp_code;
                const discRes = await fetch(
                  `https://opendart.fss.or.kr/api/list.json?crtfc_key=${env.DART_API_KEY}&corp_code=${corpCode}&bgn_de=20250101&page_count=5`
                );
                const discData = await discRes.json();
                return discData.list?.slice(0,5).map(d => `• ${d.rcept_dt} ${d.report_nm}`).join('\n') || '';
              }
              return '';
            })
        ]);

        // 뉴스 파싱
        if (newsResult.status === 'fulfilled') {
          const text = newsResult.value.content?.filter(c => c.type === 'text').map(c => c.text).join('') || '';
          realData.news = text.split('\n').filter(l => l.match(/^\d+\./)).map(l => {
            const parts = l.replace(/^\d+\.\s*/, '').split('|');
            return { title: (parts[0]||'').trim(), desc: (parts[1]||'').trim() };
          });
        }

        // 주가 파싱
        if (priceResult.status === 'fulfilled') {
          realData.price = priceResult.value.content?.filter(c => c.type === 'text').map(c => c.text).join('') || '';
        }

        // DART 파싱
        if (dartResult.status === 'fulfilled') {
          realData.dart = dartResult.value || '';
        }
      }

      // 최종 Claude 분석
      const newsText = realData.news.map((n,i) => `${i+1}. ${n.title}${n.desc?' — '+n.desc:''}`).join('\n');

      const enrichedPrompt = `${stockName ? `[분석 종목]: ${stockName}\n` : ''}
${realData.price ? `[실시간 시장 데이터]\n${realData.price}\n` : ''}
${newsText ? `[오늘의 최신 뉴스]\n${newsText}\n` : ''}
${realData.dart ? `[DART 최근 공시]\n${realData.dart}\n` : ''}

${userPrompt}

위 실제 데이터를 반드시 기반으로 분석하고, 현재 실제 주가 수치를 명시해주세요.`;

      const analysisRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1500,
          system: `당신은 주식 분석 전문가입니다. 한국어로 답변하세요.
제공된 실시간 데이터가 있으면 반드시 그 수치를 기반으로 분석하세요.
분석 형식:
[요약] 현재가 기준 핵심 결론 (실제 주가 명시)
[판단] 매수/매도/홀드
[근거 1] 밸류에이션 (실제 PER, PBR 수치 활용)
[근거 2] 최신 뉴스 이슈
[근거 3] 성장성 전망
[주의사항] 핵심 리스크
⚠️ 투자 결정은 본인 책임입니다.`,
          messages: [{ role: 'user', content: enrichedPrompt }]
        })
      });

      const analysisData = await analysisRes.json();
      const hasRealData = realData.news.length > 0 || realData.price.length > 0;

      return new Response(JSON.stringify({
        content: analysisData.content,
        news: realData.news,
        priceData: realData.price,
        dartUsed: !!realData.dart,
        hasRealData
      }), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        }
      });

    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        }
      });
    }
  }
};
