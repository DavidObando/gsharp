package Patterns

import System

func ownedProduce(output out chan[int32], count int32) {
    try {
        for value in 0 ... count {
            output <- value
        }
    } finally {
        output.Close()
    }
}

func runOwned(count int32) int32 {
    let channel = chan[int32](2)
    let reader in chan[int32] = channel
    var seen = 0
    var sum = 0
    scope {
        go ownedProduce(channel, count)
        for value in reader {
            seen++
            sum += value
        }
    }
    let (zero, ok) = <-reader
    verify(seen == count && !ok && zero == 0, "closure is not a data sentinel")
    return sum
}

func ownershipExample() {
    verify(runOwned(0) == 0 && runOwned(6) == 15, "owned channel output")
    Console.WriteLine("ownership count=6 sum=15 closed-ok=0 empty=0")
}
