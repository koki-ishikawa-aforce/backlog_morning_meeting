import type { Handler } from 'aws-lambda';
import holiday_jp from '@holiday-jp/holiday_jp';

interface LambdaResponse {
  isHoliday: boolean;
  date: string;
  holidayName?: string;
}

export const handler: Handler<Record<string, never>, LambdaResponse> = async () => {
  try {
    // 現在日時を取得（JST）
    const now = new Date();
    const jstNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));

    // YYYY-MM-DD形式
    const year = jstNow.getFullYear();
    const month = String(jstNow.getMonth() + 1).padStart(2, '0');
    const day = String(jstNow.getDate()).padStart(2, '0');
    const dateStr = `${year}-${month}-${day}`;

    // 祝日判定
    const isHoliday = holiday_jp.isHoliday(jstNow);

    if (isHoliday) {
      // 祝日の詳細情報を取得（同じ日付の範囲で検索）
      const holidays = holiday_jp.between(jstNow, jstNow);
      const holidayName = holidays.length > 0 ? holidays[0].name : '祝日';

      console.log(`本日 ${dateStr} は祝日です: ${holidayName}`);
      return {
        isHoliday: true,
        date: dateStr,
        holidayName,
      };
    }

    console.log(`本日 ${dateStr} は祝日ではありません`);
    return {
      isHoliday: false,
      date: dateStr,
    };
  } catch (error) {
    console.error('祝日チェックでエラーが発生しました:', error);
    // エラー時は処理を継続（祝日ではないとして扱う）
    return {
      isHoliday: false,
      date: new Date().toISOString().split('T')[0],
    };
  }
};
