// inventory: ClassDeclaration — partial class, part 2 of 2 (issue #1910).

package Corpus.Grid06

import System

open partial class Ledger {
    func Withdraw(amount int32) {
        _balance = _balance - amount
    }

    func Balance() int32 {
        return _balance
    }
}
