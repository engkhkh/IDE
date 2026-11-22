// Sample project for testing Nova IDE: press F5 to debug, Ctrl+F5 to run, Ctrl+Shift+B to build.
// Click left of a line number (or press F9) to set a breakpoint, then F10 / F11 to step.
Console.WriteLine("Hello from Nova IDE!");

var numbers = Enumerable.Range(1, 10);
int sum = 0;
foreach (var n in numbers)
{
    sum += n;
}
Console.WriteLine($"Sum of 1..10 = {sum}");
Console.WriteLine($"Built at {DateTime.Now:HH:mm:ss}");
