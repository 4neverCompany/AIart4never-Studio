import { NextRequest, NextResponse } from 'next/server';
import { getErrorMessage } from '@/lib/errors';
import { resolveInstagramCredentials } from '@/lib/instagram-credentials';

interface IgMediaPost {
  timestamp?: string;
  like_count?: number;
  comments_count?: number;
}

/**
 * Fetch Instagram engagement insights to determine best posting times.
 * Client calls this to prime the smart scheduler cache.
 */

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { accessToken?: string; igAccountId?: string };
    const { igAccountId, igAccessToken: accessToken } =
      resolveInstagramCredentials(process.env, body);

    if (!accessToken || !igAccountId) {
      return NextResponse.json({
        success: true,
        source: 'default',
        message: 'No Instagram credentials — using research-backed defaults',
        bestTimes: [
          { hour: 19, weight: 0.95, label: '19:00 — Prime time (highest engagement)' },
          { hour: 20, weight: 0.95, label: '20:00 — Evening peak' },
          { hour: 18, weight: 0.85, label: '18:00 — After-work peak' },
          { hour: 8,  weight: 0.80, label: '08:00 — Morning commute' },
          { hour: 12, weight: 0.75, label: '12:00 — Lunch break' },
        ],
        bestDays: [
          { day: 'Saturday', multiplier: 1.0 },
          { day: 'Friday', multiplier: 0.95 },
          { day: 'Sunday', multiplier: 0.9 },
          { day: 'Thursday', multiplier: 0.85 },
        ],
      });
    }

    // Fetch recent media with engagement metrics
    const hostUrl = accessToken.startsWith('IGAA') ? 'graph.instagram.com' : 'graph.facebook.com';
    const url = `https://${hostUrl}/${igAccountId}/media?fields=timestamp,like_count,comments_count&limit=50&access_token=${accessToken}`;

    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      const snippet = errText.slice(0, 200).replace(/\s+/g, ' ').trim();
      return NextResponse.json(
        {
          success: false,
          error: `Instagram API error ${res.status}${snippet ? `: ${snippet}` : ''}`,
          source: 'default',
        },
        { status: 200 }, // Still return 200 so client falls back gracefully
      );
    }

    const data = await res.json() as { data?: IgMediaPost[] };
    const posts: IgMediaPost[] = data.data ?? [];

    if (posts.length < 3) {
      return NextResponse.json({
        success: true,
        source: 'insufficient_data',
        message: `Only ${posts.length} posts found — need at least 3 for insights`,
        postCount: posts.length,
      });
    }

    // Analyze engagement by hour and day
    const hourMap: Record<number, { engagement: number; count: number }> = {};
    const dayMap: Record<number, { engagement: number; count: number }> = {};

    for (const post of posts) {
      if (!post.timestamp) continue;
      const date = new Date(post.timestamp);
      const hour = date.getHours();
      const day = date.getDay();
      const engagement = (post.like_count || 0) + (post.comments_count || 0) * 3;

      if (!hourMap[hour]) hourMap[hour] = { engagement: 0, count: 0 };
      hourMap[hour].engagement += engagement;
      hourMap[hour].count += 1;

      if (!dayMap[day]) dayMap[day] = { engagement: 0, count: 0 };
      dayMap[day].engagement += engagement;
      dayMap[day].count += 1;
    }

    // Normalize and sort
    const maxHourEng = Math.max(...Object.values(hourMap).map(v => v.engagement), 1);
    const maxDayEng = Math.max(...Object.values(dayMap).map(v => v.engagement), 1);

    const hourInsights = Object.entries(hourMap)
      .map(([hour, data]) => ({
        hour: parseInt(hour),
        engagement: data.engagement,
        avgEngagement: Math.round(data.engagement / data.count),
        posts: data.count,
        weight: Math.round((data.engagement / maxHourEng) * 100) / 100,
      }))
      .sort((a, b) => b.weight - a.weight);

    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const dayInsights = Object.entries(dayMap)
      .map(([day, data]) => ({
        day: parseInt(day),
        name: dayNames[parseInt(day)],
        engagement: data.engagement,
        posts: data.count,
        multiplier: Math.round((data.engagement / maxDayEng) * 100) / 100,
      }))
      .sort((a, b) => b.multiplier - a.multiplier);

    // Generate recommended posting times
    const topHours = hourInsights.slice(0, 5);
    const topDays = dayInsights.slice(0, 3);

    // Generate concrete slot recommendations
    const recommendations: { time: string; score: number; reason: string }[] = [];
    for (const day of topDays) {
      for (const hour of topHours) {
        const score = day.multiplier * hour.weight;
        recommendations.push({
          time: `${day.name} ${String(hour.hour).padStart(2, '0')}:00`,
          score: Math.round(score * 100),
          reason: `${hour.avgEngagement} avg engagement, ${day.posts} posts analyzed`,
        });
      }
    }
    recommendations.sort((a, b) => b.score - a.score);

    return NextResponse.json({
      success: true,
      source: 'instagram',
      postCount: posts.length,
      hourInsights,
      dayInsights,
      recommendations: recommendations.slice(0, 10),
      bestTimes: topHours.map(h => ({
        hour: h.hour,
        weight: h.weight,
        label: `${String(h.hour).padStart(2, '0')}:00 — avg ${h.avgEngagement} engagement (${h.posts} posts)`,
      })),
      bestDays: topDays.map(d => ({
        day: d.name,
        multiplier: d.multiplier,
      })),
    });
  } catch (e: unknown) {
    // Distinguish timeout (AbortError) from other errors so the client
    // can show "Instagram is slow" rather than "operation was aborted".
    const isTimeout =
      e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError');
    const message = isTimeout
      ? 'Instagram API timed out after 10s — using engagement defaults'
      : getErrorMessage(e);
    return NextResponse.json(
      { success: false, error: message, source: 'default' },
      { status: 200 }, // 200 so client always gets a fallback response
    );
  }
}
