// inventory: ClassDeclaration — partial class, part 1 of 2 (issue #1910: cs2gs
// merges every partial declaration into one G# type; verified by baseline
// stdout parity below).

package Corpus.Grid06

import System

open partial class Ledger {
    private var _balance int32

    func Deposit(amount int32) {
        _balance = _balance + amount
    }
}

shared class PartialClassFixture {
    func Run() {
        let ledger = Ledger()
        ledger.Deposit(40)
        ledger.Withdraw(15)
        Console.WriteLine("PartialClass: balance=" + ledger.Balance().ToString())
    }
}
