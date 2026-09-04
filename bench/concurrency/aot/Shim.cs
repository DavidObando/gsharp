// ADR-0174 D11. Placeholder so csc produces an assembly for the AOT publish to
// replace; see BenchAot.csproj. The entry point that actually runs is the one
// gsc emitted, which C# cannot name — ILC reads it from the assembly's metadata
// and never needs a source-level reference to it.
internal static class Shim
{
    private static void Main()
    {
    }
}
