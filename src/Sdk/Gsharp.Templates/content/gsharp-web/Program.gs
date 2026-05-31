// file: Program.gs
//
// Minimal ASP.NET Core web application written in GSharp. It uses the modern
// WebApplication host (Kestrel) and minimal-API endpoint routing to map an
// HTTP GET endpoint that returns a plain-text response.
//
// The endpoint handler is declared as a `Func[string]` value first so it binds
// cleanly to the delegate `MapGet` expects, then it is registered for the "/"
// route. `app.Run(url)` starts Kestrel and blocks until the process stops.

package GsharpWebApp

import System
import Microsoft.AspNetCore.Builder
import Microsoft.AspNetCore.Routing
import Microsoft.Extensions.Hosting

var builder = WebApplication.CreateBuilder()
var app = builder.Build()

var hello Func[string] = func() string { return "Hello from GSharp on ASP.NET Core!" }
app.MapGet("/", hello)

// Start Kestrel and block until the process is stopped.
app.Run("http://localhost:5117")
