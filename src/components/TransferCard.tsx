import React, { useState, useEffect, useMemo } from 'react';
import { useGame } from '../context/GameContext';
import { formatMoney, generateIdemKey } from '../lib/constants';
import { localApi } from '../lib/api';
import { sound } from '../lib/sound';
import { ACCOUNT_CATEGORIES } from '../lib/domain';

export const TransferCard: React.FC<{ targetPlayerId?: string | null }> = ({ targetPlayerId }) => {
  const {
    game,
    players,
    appMode,
    myPlayerId,
    activeTransferTab,
    setActiveTransferTab,
    openModal,
    showToast,
    refreshActiveGame,
    customDesc,
    setCustomDesc,
  } = useGame();

  const isPlayerMode = appMode === 'player' && !!myPlayerId;
  const me = isPlayerMode ? players.find((p) => p.id === myPlayerId) : null;
  const curr = game?.currency || '₹';

  // Form states
  const [fromAccount, setFromAccount] = useState<string>('BANK');
  const [toAccount, setToAccount] = useState<string>('BANK');
  const [category, setCategory] = useState<string>('RENT');
  const [amount, setAmount] = useState<string>('');

  // Handle external selection shortcut (e.g. from roster)
  useEffect(() => {
    if (targetPlayerId) {
      setToAccount(targetPlayerId);
    }
  }, [targetPlayerId]);

  // Adjust options and defaults when tab or mode changes
  useEffect(() => {
    if (isPlayerMode && me) {
      setFromAccount(me.id);
      if (activeTransferTab === 'rent') {
        setCategory('RENT');
        // If to is BANK, switch to first other player
        if (toAccount === 'BANK') {
          const other = players.find((p) => p.id !== me.id && !p.is_bankrupt);
          if (other) setToAccount(other.id);
        }
      } else if (activeTransferTab === 'pay-bank') {
        setToAccount('BANK');
        if (!['INCOME_TAX', 'FINE', 'PROPERTY_PURCHASE', 'BUILD', 'EXPENSE'].includes(category)) {
          setCategory('INCOME_TAX');
        }
      }
    } else {
      // Banker mode
      if (activeTransferTab === 'bank-pay') {
        setFromAccount('BANK');
        if (!['SALARY', 'LOAN', 'MORTGAGE', 'INCOME', 'GIFT'].includes(category)) {
          setCategory('SALARY');
        }
        if (toAccount === 'BANK') {
          const firstPl = players.find((p) => !p.is_bankrupt);
          if (firstPl) setToAccount(firstPl.id);
        }
      }
    }
  }, [activeTransferTab, isPlayerMode, me, players]);

  // Compute balances
  const fromBalance = useMemo(() => {
    if (fromAccount === 'BANK') return game?.bank_balance ?? 0;
    const p = players.find((x) => x.id === fromAccount);
    return p ? p.cash : 0;
  }, [fromAccount, game, players]);

  const toBalance = useMemo(() => {
    if (toAccount === 'BANK') return game?.bank_balance ?? 0;
    const p = players.find((x) => x.id === toAccount);
    return p ? p.cash : 0;
  }, [toAccount, game, players]);

  // Compute helper text
  const helperText = useMemo(() => {
    switch (activeTransferTab) {
      case 'rent':
        return isPlayerMode
          ? 'Pay rent to another player for landing on their property'
          : 'Bob pays Alice for landing on her property (RENT category)';
      case 'pay-bank':
        return isPlayerMode
          ? 'Pay Bank drawer for Taxes, Fines, or Buying properties'
          : 'Player pays Bank drawer for Taxes, Fines, or Buying properties';
      case 'bank-pay':
        return 'Bank drawer funds a player (Salary, Bonus, Mortgage, Loan)';
      case 'custom':
      default:
        return isPlayerMode
          ? 'Send money from your wallet to any counterparty'
          : 'Free-form transfer between any accounts and categories';
    }
  }, [activeTransferTab, isPlayerMode]);

  // Auto-suggested description placeholder
  const autoDesc = useMemo(() => {
    const fromName = fromAccount === 'BANK' ? 'Bank' : players.find((p) => p.id === fromAccount)?.name || 'Payer';
    const toName = toAccount === 'BANK' ? 'Bank' : players.find((p) => p.id === toAccount)?.name || 'Recipient';
    return `${category}: ${fromName} -> ${toName}`;
  }, [fromAccount, toAccount, category, players]);

  // Validation
  const numAmount = parseInt(amount || '0', 10);
  let validationError = '';

  if (fromAccount === toAccount) {
    validationError = 'Payer and Recipient cannot be the same account';
  } else if (numAmount > fromBalance) {
    if (fromAccount === 'BANK') {
      validationError = `Bank drawer has insufficient funds (Deficit: ${formatMoney(numAmount - fromBalance, curr)})`;
    } else {
      validationError = `Insufficient cash (Player has ${formatMoney(fromBalance, curr)}, deficit ${formatMoney(numAmount - fromBalance, curr)})`;
    }
  }

  const isValid = !validationError && numAmount > 0;

  const handleQuickAdd = (add: number) => {
    const cur = parseInt(amount || '0', 10);
    setAmount(String(cur + add));
  };

  const handleClearAmount = () => {
    setAmount('');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValid || !game) return;

    const fromAcc = fromAccount === 'BANK' ? { type: 'bank', id: 'BANK' } : { type: 'player', id: fromAccount };
    const toAcc = toAccount === 'BANK' ? { type: 'bank', id: 'BANK' } : { type: 'player', id: toAccount };
    const desc = customDesc.trim() || autoDesc;
    const idemKey = generateIdemKey('transfer');

    try {
      await localApi(`/games/${game.id}/transfers`, {
        method: 'POST',
        headers: { 'Idempotency-Key': idemKey },
        body: {
          from: fromAcc,
          to: toAcc,
          amount: numAmount,
          account_category: category,
          description: desc,
        },
      });

      sound.playCoin();
      showToast(`Transferred ${formatMoney(numAmount, curr)} (${category})`, 'success');
      setAmount('');
      setCustomDesc('');
      await refreshActiveGame();
    } catch (err: any) {
      showToast(err.message || 'Transfer failed', 'error');
    }
  };

  return (
    <div className="card transfer-center-card" id="transfer-card">
      <div className="card-header tab-header">
        <div className="tabs-nav">
          {isPlayerMode ? (
            <>
              <button
                type="button"
                className={`tab-btn ${activeTransferTab === 'rent' ? 'active' : ''}`}
                onClick={() => setActiveTransferTab('rent')}
              >
                <span className="tab-icon">🏠</span> Pay Rent
              </button>
              <button
                type="button"
                className={`tab-btn ${activeTransferTab === 'pay-bank' ? 'active' : ''}`}
                onClick={() => setActiveTransferTab('pay-bank')}
              >
                <span className="tab-icon">🏛️</span> Pay Bank (Tax/Fine/Buy)
              </button>
              <button
                type="button"
                className={`tab-btn ${activeTransferTab === 'custom' ? 'active' : ''}`}
                onClick={() => setActiveTransferTab('custom')}
              >
                <span className="tab-icon">🔄</span> Custom Transfer
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className={`tab-btn ${activeTransferTab === 'bank-pay' ? 'active' : ''}`}
                onClick={() => setActiveTransferTab('bank-pay')}
              >
                <span className="tab-icon">💰</span> Bank Payout (Salary/Loan)
              </button>
              <button
                type="button"
                className={`tab-btn ${activeTransferTab === 'custom' ? 'active' : ''}`}
                onClick={() => setActiveTransferTab('custom')}
              >
                <span className="tab-icon">🔄</span> Custom Transfer
              </button>
              <button
                type="button"
                className={`tab-btn ${activeTransferTab === 'rent' ? 'active' : ''}`}
                onClick={() => setActiveTransferTab('rent')}
              >
                <span className="tab-icon">🏠</span> Pay Rent
              </button>
              <button
                type="button"
                className={`tab-btn ${activeTransferTab === 'pay-bank' ? 'active' : ''}`}
                onClick={() => setActiveTransferTab('pay-bank')}
              >
                <span className="tab-icon">🏛️</span> Pay Bank
              </button>
            </>
          )}
        </div>
        <span className="text-muted text-xs helper-text" id="tab-helper-text">
          {helperText}
        </span>
      </div>

      <div className="card-body">
        <form id="form-transfer" autoComplete="off" onSubmit={handleSubmit}>
          {/* Flow Selector Row */}
          <div className="transfer-flow-row">
            {/* From Selector */}
            <div className="form-group flow-entity" id="flow-from-group">
              <label className="flow-label">From (Payer)</label>
              <select
                id="transfer-from-select"
                className="form-select flow-select"
                value={fromAccount}
                disabled={isPlayerMode || activeTransferTab === 'bank-pay'}
                onChange={(e) => setFromAccount(e.target.value)}
                required
              >
                {isPlayerMode && me ? (
                  <option value={me.id}>👤 {me.name} (You - Locked)</option>
                ) : (
                  <>
                    <option value="BANK">🏛️ Bank Drawer</option>
                    {players
                      .filter((p) => !p.is_bankrupt)
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          👤 {p.name}
                        </option>
                      ))}
                  </>
                )}
              </select>
              <div className="balance-hint" id="from-balance-hint">
                Balance: {formatMoney(fromBalance, curr)}
              </div>
            </div>

            {/* Arrow Icon */}
            <div className="flow-arrow">
              <div className="arrow-circle">
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M5 12h14M12 5l7 7-7 7" />
                </svg>
              </div>
            </div>

            {/* To Selector */}
            <div className="form-group flow-entity" id="flow-to-group">
              <label className="flow-label">To (Recipient)</label>
              <select
                id="transfer-to-select"
                className="form-select flow-select"
                value={toAccount}
                disabled={activeTransferTab === 'pay-bank'}
                onChange={(e) => setToAccount(e.target.value)}
                required
              >
                {activeTransferTab !== 'rent' && <option value="BANK">🏛️ Bank Drawer</option>}
                {players
                  .filter((p) => !p.is_bankrupt && (isPlayerMode ? p.id !== me?.id : true))
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      👤 {p.name}
                    </option>
                  ))}
              </select>
              <div className="balance-hint" id="to-balance-hint">
                Balance: {formatMoney(toBalance, curr)}
              </div>
            </div>

            {/* Category */}
            <div className="form-group flow-category" id="flow-cat-group">
              <label className="flow-label">Category</label>
              <select
                id="transfer-category-select"
                className="form-select flow-select"
                value={category}
                disabled={activeTransferTab === 'rent'}
                onChange={(e) => setCategory(e.target.value)}
              >
                {ACCOUNT_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Amount Row */}
          <div className="amount-row compact-amount-row">
            <div className="form-group amount-input-group">
              <label htmlFor="transfer-amount">
                Amount (<span className="currency-sym">{curr}</span>)
              </label>
              <div className="amount-with-note">
                <div className="input-with-sym">
                  <span className="sym-prefix">{curr}</span>
                  <input
                    type="number"
                    id="transfer-amount"
                    className="form-input amount-input"
                    placeholder="0"
                    min="1"
                    step="1"
                    required
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                  />
                </div>
                <button
                  type="button"
                  id="btn-open-desc-modal"
                  className="btn btn-secondary btn-note"
                  title="Add / View memo description"
                  onClick={() => openModal('transfer-desc', { autoDesc })}
                >
                  <span>📝</span>
                  <span className="note-label">Note</span>
                  {customDesc && <span id="desc-dot" className="desc-dot" style={{ display: 'inline-block' }} />}
                </button>
              </div>
            </div>

            {/* Quick Amount Chips */}
            <div className="quick-amount-chips">
              <button type="button" className="chip-btn" onClick={() => handleQuickAdd(100)}>
                +100
              </button>
              <button type="button" className="chip-btn" onClick={() => handleQuickAdd(500)}>
                +500
              </button>
              <button type="button" className="chip-btn" onClick={() => handleQuickAdd(1000)}>
                +1k
              </button>
              <button type="button" className="chip-btn chip-clear" id="chip-clear" onClick={handleClearAmount}>
                Clear
              </button>
            </div>
          </div>

          {/* Submit Row */}
          <div className="submit-row compact-submit-row">
            <div id="transfer-validation-msg" className="validation-msg">
              {validationError}
            </div>
            <button
              type="submit"
              id="btn-submit-transfer"
              className="btn btn-emerald btn-lg btn-block"
              disabled={!isValid}
            >
              <span className="btn-icon">⚡</span> Post Transfer
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
