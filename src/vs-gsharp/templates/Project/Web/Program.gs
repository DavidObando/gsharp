package $safeprojectname$

import System
import Microsoft.AspNetCore.Builder
import Microsoft.AspNetCore.Routing
import Microsoft.Extensions.Hosting

var builder = WebApplication.CreateBuilder()
var app = builder.Build()

var hello Func[string] = func() string { return "Hello from G# on ASP.NET Core!" }
app.MapGet("/", hello)
app.Run("http://localhost:5117")
