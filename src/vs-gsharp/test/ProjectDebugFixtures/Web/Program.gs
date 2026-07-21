package VsAcceptance.Web

import Microsoft.AspNetCore.Builder

var builder = WebApplication.CreateBuilder()
var app = builder.Build()
var health Func[string] = func() string { return "gsharp-vs-acceptance" }
app.MapGet("/", health)
app.Run()
