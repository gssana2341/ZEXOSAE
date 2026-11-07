import { el } from './dom';
import type { MatchState, PlayerInfo } from './net/protocol';
import { MIN_MATCH_PLAYERS, MODE_INFO } from './sim/game-modes';

export interface ResultActions {
  ready(ready: boolean): void;
  leave(): void;
}

function setText(node: HTMLElement, value: string): void {
  if (node.textContent !== value) node.textContent = value;
}

/** A persistent end-of-round screen; the room controls when everyone plays again. */
export class MatchResults {
  private readonly root = el('section', 'match-results');
  private readonly mode = el('p', 'results-kicker');
  private readonly title = el('h1', 'results-title');
  private readonly detail = el('p', 'results-detail');
  private readonly table = el('table', 'results-table');
  private readonly head = el('tr');
  private readonly body = el('tbody');
  private readonly empty = el('p', 'results-empty');
  private readonly status = el('p', 'results-status');
  private readonly hostNote = el('p', 'results-host-note', 'หากเจ้าของห้องออก ห้องจะปิดสำหรับทุกคน');
  private readonly readyButton = el('button', 'btn primary', 'พร้อมเล่นอีกครั้ง');
  private readonly leaveButton = el('button', 'btn', 'ออกจากห้อง');
  private isReady = false;
  private boardKey = '';

  constructor(parent: HTMLElement, private readonly actions: ResultActions) {
    this.root.hidden = true;
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-modal', 'true');
    this.root.setAttribute('aria-labelledby', 'results-title');
    this.title.id = 'results-title';
    this.status.setAttribute('aria-live', 'polite');
    this.table.setAttribute('aria-label', 'ผลการแข่งขันรายบุคคล');
    const thead = el('thead');
    thead.append(this.head);
    this.table.append(thead, this.body);

    const panel = el('div', 'results-panel');
    const heading = el('div', 'results-heading');
    const icon = el('span', 'results-medal', '🏆');
    icon.setAttribute('aria-hidden', 'true');
    const headingText = el('div', 'results-heading-text');
    headingText.append(this.mode, this.title, this.detail);
    heading.append(icon, headingText);
    const board = el('div', 'results-board');
    board.append(this.table, this.empty);
    const buttons = el('div', 'results-actions');
    buttons.append(this.readyButton, this.leaveButton);
    panel.append(heading, board, this.status, buttons, this.hostNote);
    this.root.append(panel);
    parent.append(this.root);
    this.readyButton.addEventListener('click', () => this.actions.ready(!this.isReady));
    this.leaveButton.addEventListener('click', () => this.actions.leave());
  }

  update(match: MatchState, players: PlayerInfo[], myId: number, watching: boolean, isHost = false): void {
    const opening = this.root.hidden;
    this.root.hidden = false;
    const crown = match.mode === 'crown';
    setText(this.mode, `จบการแข่งขัน · ${MODE_INFO[match.mode].name}`);
    setText(this.title, match.result || 'จบการแข่งขัน');
    setText(this.detail, match.mode === 'teams'
      ? `🔴 ทีมแดง ${match.teamScores.red}  ·  ${match.teamScores.blue} ทีมน้ำเงิน 🔵  |  อันดับส่วนบุคคล`
      : crown ? 'ผู้ที่ถือมงกุฎตอนหมดเวลาเป็นผู้ชนะ' : 'อันดับส่วนบุคคล');

    const boardKey = JSON.stringify([match.mode, match.standings, myId, players.map((p) => p.id)]);
    if (boardKey !== this.boardKey) {
      this.boardKey = boardKey;
      const headings = ['อันดับ', 'ผู้เล่น', crown ? 'มงกุฎ' : match.mode === 'control' ? 'เวลายึด' : 'คะแนน', 'KO', 'ตาย'];
      this.head.replaceChildren(...headings.map((name) => {
        const cell = el('th', '', name);
        cell.scope = 'col';
        return cell;
      }));
      const present = new Set(players.map((p) => p.id));
      const rows = (match.standings ?? []).map((player) => {
        const row = el('tr', player.id === myId ? 'me' : '');
        const team = player.team ? (player.team === 'red' ? '🔴 ' : '🔵 ') : '';
        const left = present.has(player.id) ? '' : ' (ออกแล้ว)';
        const score = crown ? (player.rank === 1 ? '👑' : '—')
          : match.mode === 'control' ? `${Number(player.score.toFixed(2))} วิ` : String(player.score);
        const values = [player.rank === null ? '—' : `#${player.rank}`, `${team}${player.name}${left}`, score, String(player.kills), String(player.deaths)];
        for (const [i, value] of values.entries()) row.append(el('td', i === 1 ? 'results-name' : '', value));
        return row;
      });
      this.body.replaceChildren(...rows);
      this.table.hidden = rows.length === 0;
      this.empty.hidden = rows.length > 0;
      this.empty.textContent = match.standings ? 'ไม่มีผู้เล่นในรอบนี้' : 'กำลังโหลดผลการแข่งขัน…';
    }

    const ready = new Set(match.ready);
    this.isReady = ready.has(myId);
    const active = players.filter((player) => ready.has(player.id)).length;
    const waiting = players.filter((player) => !ready.has(player.id)).map((player) => player.name);
    const progress = `พร้อมแล้ว ${active}/${players.length} คน`;
    setText(this.status, watching
      ? `${progress} · รอผู้เล่นเริ่มรอบถัดไป`
      : players.length < MIN_MATCH_PLAYERS
        ? `${progress} · รอผู้เล่นเพิ่มอย่างน้อย ${MIN_MATCH_PLAYERS} คน`
        : waiting.length ? `${progress} · รอ ${waiting.join(', ')}` : `${progress} · กำลังเริ่มรอบใหม่`);
    this.readyButton.hidden = watching;
    this.readyButton.disabled = !players.some((player) => player.id === myId);
    this.readyButton.setAttribute('aria-pressed', String(this.isReady));
    this.hostNote.hidden = !isHost;
    setText(this.readyButton, this.isReady ? '✓ พร้อมแล้ว · กดยกเลิกได้' : 'พร้อมเล่นอีกครั้ง');
    if (opening) (watching ? this.leaveButton : this.readyButton).focus({ preventScroll: true });
  }

  hide(): void {
    this.root.hidden = true;
    this.boardKey = '';
  }
}
