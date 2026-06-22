import System
import System.Collections.Generic

// Sequence/list initializer: bare elements lower to Add per element.
var primes = List[int32]{ 2, 3, 5, 7, 11 }
Console.WriteLine(primes.Count)
Console.WriteLine(primes[0])
Console.WriteLine(primes[4])

// Set initializer: HashSet.Add deduplicates, so repeated elements collapse.
var unique = HashSet[int32]{ 1, 2, 2, 3, 3, 3 }
Console.WriteLine(unique.Count)
Console.WriteLine(unique.Contains(2))

// Dictionary initializer with key: value pairs (Swift-style).
var scores = Dictionary[string, int32]{ "alice": 90, "bob": 85 }
Console.WriteLine(scores.Count)
Console.WriteLine(scores["alice"])

// Dictionary initializer with [key] = value indexer entries (C#-style).
var ages = Dictionary[string, int32]{ ["carol"] = 31, ["dave"] = 27 }
Console.WriteLine(ages["carol"])
Console.WriteLine(ages["dave"])

// Explicit constructor arguments: a case-insensitive comparer.
var headers = Dictionary[string, int32](StringComparer.OrdinalIgnoreCase){ "Content-Length": 42 }
Console.WriteLine(headers["content-length"])

// Nested collection initializers compose.
var grid = List[List[int32]]{ List[int32]{ 1, 2 }, List[int32]{ 3, 4, 5 } }
Console.WriteLine(grid.Count)
Console.WriteLine(grid[1].Count)

// Dictionary with collection-initializer values.
var groups = Dictionary[string, List[int32]]{ "evens": List[int32]{ 2, 4 }, "odds": List[int32]{ 1, 3, 5 } }
Console.WriteLine(groups["evens"].Count)
Console.WriteLine(groups["odds"].Count)
