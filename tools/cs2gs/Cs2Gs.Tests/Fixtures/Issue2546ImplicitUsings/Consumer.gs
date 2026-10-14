package Issue2546

import System
import System.Collections.Generic
import System.IO
import System.Net.Http
import System.Text.RegularExpressions
import System.Threading
import System.Threading.Tasks

internal class Consumer {
    var Items List[string] = List[string]()
    var Client HttpClient = HttpClient()
    var Token CancellationToken = default(CancellationToken)

    func Complete(path string) object {
        Console.WriteLine(path)
        return Task.FromResult(Regex.Replace(Path.GetFileName(path), "\\s", string.Empty))
    }
}
