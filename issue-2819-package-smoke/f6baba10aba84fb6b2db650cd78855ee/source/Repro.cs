
#nullable enable
namespace Demo
{
    public class C
    {
        public string[]? G() => null;

        public string? Value() =>
            G() is { } values && values.Length > 0 ? values[0] : null;
    }
}