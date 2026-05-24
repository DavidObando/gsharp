// file: Program.gs
//
// Minimal GSharp web application. Uses the BCL HttpListener to serve a single
// "Hello from GSharp web!" response on http://localhost:5000/.
//
// Once GSharp grows attribute syntax and async/Task support, this template
// will be upgraded to use Microsoft.AspNetCore.* directly.

package GsharpWebApp

import System
import System.Net
import System.Text

var prefix = "http://localhost:5000/"

var listener = HttpListener()
listener.Prefixes.Add(prefix)
listener.Start()

Console.WriteLine("Listening on $prefix")
Console.WriteLine("Press Ctrl+C to stop.")

for true {
    var context = listener.GetContext()
    var response = context.Response
    var body = Encoding.UTF8.GetBytes("Hello from GSharp web!")
    response.ContentLength64 = body.Length
    response.OutputStream.Write(body, 0, body.Length)
    response.OutputStream.Close()
}
