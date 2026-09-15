package Website.Interop

import System
import System.Collections.Generic
import System.Linq

let numbers = List[int32]{1, 2, 3, 4}
let total = numbers
    .Where((n int32) -> n % 2 == 0)
    .Select((n int32) -> n * 10)
    .Sum()

Console.WriteLine(total)
