package Patterns

import Gsharp.Concurrency
import System
import System.Collections.Generic

func fanProduce(output out chan[int32], offset int32) {
    try {
        for value in 0 ... 5 {
            output <- offset + value
        }
    } finally {
        output.Close()
    }
}

func fanForward(input in chan[int32], output out chan[int32]) {
    for value in input {
        output <- value
    }
}

func fanSources(count int32, output out chan[int32]) {
    try {
        scope {
            for id in 0 ... count {
                let input = chan[int32](2)
                go fanProduce(input, id * 10)
                go fanForward(input, output)
            }
        }
    } finally {
        output.Close()
    }
}

func mergeSources(count int32) int32 {
    let output = chan[int32](2)
    let seen = HashSet[int32]()
    var sum = 0
    scope {
        go fanSources(count, output)
        for value in output {
            verify(seen.Add(value), "fan-in duplicated a value")
            sum += value
        }
    }
    verify(seen.Count == count * 5, "fan-in lost a value")
    return sum
}

func fanInExample() {
    verify(mergeSources(0) == 0, "empty fan-in")
    verify(mergeSources(3) == 180, "merged sum")
    let left = chan[int32](1)
    let right = chan[int32](1)
    left <- 1
    right <- 2
    left.Close()
    right.Close()
    var helperSum = 0
    for value in merge[int32](left, right) {
        helperSum += value
    }
    verify(helperSum == 3, "SDK merge helper")
    var empty = 0
    for value in merge[int32]() {
        empty++
    }
    verify(empty == 0, "empty SDK merge")
    Console.WriteLine("fan-in count=15 sum=180 empty=0")
}
