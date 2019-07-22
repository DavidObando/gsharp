// file: Loop.gs

package GSharp.Example.Loop

import System

func Main(args string[]) {
  count := 0
  if args.Length == 1 {
    Int.TryParse(args[0], *count)
  }
  
  for i := count; i > 0; i-- {
    Console.WriteLine("Count value: {i}")
  }
}
