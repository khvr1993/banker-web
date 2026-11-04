import React, { useState, useEffect } from 'react';
import { useGame } from '../../context/GameContext';
import { localApi } from '../../lib/api';
import { formatMoney } from '../../lib/constants';
import { Game } from '../../types';

export const GamesListModal: React.FC = () => {
  const { currentGameId, loadGame, closeModal, openModal } = useGame();
  const [games, setGames] = useState<Game[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const fetchGames = async () => {
      try {
        setLoading(true);
        const data = await localApi('/games');
        setGames(data.games || []);
      } catch (err: any) {
        setError(err.message || 'Failed to load games');
      } finally {
        setLoading(false);
      }
    };
    fetchGames();
  }, []);

  const filteredGames = games.filter(
    (g) => g.name.toLowerCase().includes(search.toLowerCase()) || g.id.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="modal-backdrop" id="modal-games-list" style={{ display: 'flex' }}>
      <div className="modal-dialog">
        <div className="modal-header">
          <h3>Game Sessions</h3>
          <button className="modal-close" onClick={closeModal}>
            &times;
          </button>
        </div>
        <div className="modal-body">
          <div className="modal-toolbar">
            <input
              type="text"
              id="search-games"
              className="form-input"
              placeholder="Search games..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <button
              className="btn btn-primary btn-sm"
              id="btn-modal-create-game"
              onClick={() => openModal('new-game')}
            >
              + New Game
            </button>
          </div>
          <div className="games-list-container" id="games-list-container">
            {loading ? (
              <div className="text-muted text-center p-4">Loading game sessions...</div>
            ) : error ? (
              <div className="text-ruby text-center p-4">{error}</div>
            ) : filteredGames.length === 0 ? (
              <div className="text-muted text-center p-4">
                No games found. Click &quot;+ New Game&quot; to start one!
              </div>
            ) : (
              filteredGames.map((g) => {
                const isCurrent = g.id === currentGameId;
                return (
                  <div
                    key={g.id}
                    className="lobby-player-row mb-2"
                    style={{ marginBottom: '8px' }}
                  >
                    <div>
                      <strong style={{ color: '#fff' }}>{g.name}</strong>
                      <span className={`status-badge ${g.status} ml-2`}>
                        {g.status.toUpperCase()}
                      </span>
                      <div className="text-xs text-muted">
                        Round {g.current_round} • Drawer: {formatMoney(g.bank_balance, g.currency)}
                      </div>
                    </div>
                    <button
                      className={`btn ${isCurrent ? 'btn-emerald' : 'btn-secondary'} btn-xs btn-pick-game`}
                      onClick={() => {
                        closeModal();
                        loadGame(g.id);
                      }}
                    >
                      {isCurrent ? 'Current' : 'Open'}
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
