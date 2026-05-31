// file: Program.gs
//
// Minimal ASP.NET Core web application written in GSharp. It uses the modern
// WebApplication host (Kestrel) and a terminal request handler that writes a
// plain-text response for every request.
//
// The handler is declared as a `RequestDelegate` value so the function literal
// converts cleanly to the delegate the ASP.NET pipeline expects, then it is
// registered as terminal middleware with `app.Run(handler)`.

package GsharpWebApp

import Microsoft.AspNetCore.Builder
import Microsoft.AspNetCore.Http
import System.Threading
import System.Threading.Tasks

var builder = WebApplication.CreateBuilder()
var app = builder.Build()

var handler RequestDelegate = func(context HttpContext) Task {
    return context.Response.WriteAsync("Hello from GSharp on ASP.NET Core!", CancellationToken.None)
}

// Register the handler as terminal middleware: it runs for every request.
app.Run(handler)

// Start Kestrel and block until the process is stopped.
app.Run("http://localhost:5000")
