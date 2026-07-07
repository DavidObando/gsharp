package SourceGen

import System
import CommunityToolkit.Mvvm.ComponentModel

// ADR-0145 §E/§F: the `@ObservableProperty` attribute is consumed by the
// CommunityToolkit.Mvvm Roslyn source generator. The Gsharp.NET.Sdk runs that
// generator (via gsgen) before gsc, projecting this `Message` field into a
// generated `Message` property on the partial class.
partial class Greeter : ObservableObject {
    @ObservableProperty
    var message string
}

var g = Greeter{}
g.Message = "hello from a source generator"
Console.WriteLine(g.Message)
