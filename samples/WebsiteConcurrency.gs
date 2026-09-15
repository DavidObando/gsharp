package Website.Concurrency

import System

func send(value int32, results chan[int32]) {
    results <- value
}

let results = chan[int32](2)

scope {
    go send(10, results)
    go send(32, results)
}

Console.WriteLine(<-results + <-results)
