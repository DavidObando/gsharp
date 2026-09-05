// file: AsyncLet.gs
//
// ADR-0174 pattern: spawn now, use later. `async let name = expr` starts
// `expr` as a child of the enclosing `scope` and binds `name` to its eventual
// result. Both children below start immediately and run concurrently; the
// binding names the result, not a task, so `await user` is a `string`.
//
// The `await` is required at every read, because the read is where the
// suspension happens. Reading a second time returns the completed value
// without suspending.

package GSharp.Samples.AsyncLet

import System

func fetchUser(id int32) string {
    let ch = chan [string](1)
    ch <- "user-" + id.ToString()
    return <-ch
}

func fetchOrders(id int32) int32 {
    let ch = chan [int32](1)
    ch <- id * 3
    return <-ch
}

scope {
    async let user = fetchUser(7)
    async let orders = fetchOrders(7)

    Console.WriteLine("user: " + (await user))
    Console.WriteLine("orders: " + (await orders).ToString())
    Console.WriteLine("user again: " + (await user))
}
