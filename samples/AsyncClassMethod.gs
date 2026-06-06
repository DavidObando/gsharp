// file: AsyncClassMethod.gs
//
// Issue #502 exit sample. `async func` declared as an instance member of a
// `type X class { ... }` body — and also inside a `shared { ... }` static
// block — parses, binds, and emits the same Task / Task<T> shape as a
// top-level `async func` (see AsyncTask.gs).
//
// This is the natural xUnit shape for I/O-bound tests (`[Fact] async func`)
// and a prerequisite for porting C# test suites whose Task-returning
// methods sit on a class.

package GSharp.Samples.AsyncClassMethod

import System
import System.Threading.Tasks

type Adder class(Base int32) {
    async func Bump(n int32) int32 {
        await Task.Delay(1)
        return Base + n
    }

    async func Print() {
        await Task.Delay(1)
        Console.WriteLine("base = $Base")
    }
}

type Math2 class {
    shared {
        async func Triple(n int32) int32 {
            await Task.Delay(1)
            return n * 3
        }
    }
}

let a = Adder(40)
a.Print().Wait()
let bumped = a.Bump(2).Result
Console.WriteLine("bumped = $bumped")

let tripled = Math2.Triple(14).Result
Console.WriteLine("tripled = $tripled")

Console.WriteLine("done")
