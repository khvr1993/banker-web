import React, { useState, useEffect } from 'react';
import { useGame } from '../../context/GameContext';
import { localApi } from '../../lib/api';
import { formatMoney } from '../../lib/constants';
import { Player, StatementRow } from '../../types';

export const PlayerStatementModal: React.FC = () => {
  const { game, closeModal, modalPayload, players } = useGame();
  const player: Player | undefined = modalPayload?.player;
  const [statement, setStatement] = useState<StatementRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const curr = game?.currency || '₹';

  useEffect(() => {
    if (!game || !player) return;
    const fetchStatement = async () => {
      try {
        setLoading(true);
        const res = await localApi(`/games/${game.id}/players/${player.id}/ledger`);
        const rows: StatementRow[] = res.statement || [];
        rows.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
        setStatement(rows);
      } catch (err: any) {
        setError(err.message || 'Failed to load statement');
      } finally {
        setLoading(false);
      }
    };
    fetchStatement();
  }, [game, player]);

  if (!player) return null;

  return (
    <div className="modal-backdrop" id="modal-player-statement">
      <div className="modal-dialog modal-lg">
        <div className="modal-header">
          <div>
            <h3 id="stmt-player-name">{player.name}&apos;s Statement</h3>
            <span className="text-muted text-sm mono-num" id="stmt-player-balance">
              Balance: {formatMoney(player.cash, curr)}
            </span>
          </div>
          <button className="modal-close" onClick={closeModal}>
            &times;
          </button>
        </div>
        <div className="modal-body no-padding">
          <div className="table-container max-h-500">
            <table className="ledger-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Round</th>
                  <th>Category</th>
                  <th>Counterparty</th>
                  <th style={{ textAlign: 'right' }}>Debit (Out)</th>
                  <th style={{ textAlign: 'right' }}>Credit (In)</th>
                  <th>Description</th>
                </tr>
              </thead>
              <tbody id="stmt-tbody">
                {loading ? (
                  <tr>
                    <td colSpan={7} className="text-center text-muted p-4">
                      Loading statement...
                    </td>
                  </tr>
                ) : error ? (
                  <tr>
                    <td colSpan={7} className="text-ruby text-center p-4">
                      {error}
                    </td>
                  </tr>
                ) : statement.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="text-center text-muted p-4">
                      No transactions on record for this player.
                    </td>
                  </tr>
                ) : (
                  statement.map((r) => {
                    const timeStr = r.created_at ? r.created_at.split('T')[1]?.substring(0, 8) : '';
                    const counterpartyName =
                      r.counterparty === 'BANK'
                        ? 'Bank Reserve'
                        : players.find((p) => p.id === r.counterparty)?.name || r.counterparty || '-';

                    return (
                      <tr key={r.txn_id} className={r.voided ? 'is-voided' : ''}>
                        <td className="text-xs text-muted mono-num">{timeStr}</td>
                        <td className="mono-num text-muted">R{r.round}</td>
                        <td>
                          <span className="category-text mono-num">{r.account_category}</span>
                        </td>
                        <td>
                          <span className="counterparty-text">{counterpartyName}</span>
                        </td>
                        <td style={{ textAlign: 'right' }} className={`mono-num ${r.dr > 0 ? 'amount-dr' : 'text-dim'}`}>
                          {r.dr > 0 ? formatMoney(r.dr, curr) : '-'}
                        </td>
                        <td style={{ textAlign: 'right' }} className={`mono-num ${r.cr > 0 ? 'amount-cr' : 'text-dim'}`}>
                          {r.cr > 0 ? formatMoney(r.cr, curr) : '-'}
                        </td>
                        <td className="text-xs text-muted">{r.description || '-'}</td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={closeModal}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
